import { Inject, Injectable } from '@nestjs/common';
import { normalizePassword, type ChangePasswordBody, type LoginBody, type RegisterBody } from '@classepulse/shared';
import { v7 as uuidv7 } from 'uuid';
import { isUniqueViolation } from '../../database/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { AnonymousActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { ClassesService } from '../classes/classes.service.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { CommonPasswords } from '../users/common-passwords.js';
import { PasswordHasher } from '../users/password-hasher.js';
import { validateNewPassword } from '../users/password-policy.js';
import { UsersService } from '../users/users.service.js';
import type { ClientContext } from './client-context.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { SessionsService, type OpenedSession } from './sessions.service.js';
import { TurnstileGate } from './turnstile.js';

/** Nouvel essai de Turnstile 60 s après l'entrée en mode dégradé (R7). */
const SIGNUP_RETRY_AFTER_SECONDS = 60;

function tooManyAttempts(retryAfter: number): ApiError {
  return new ApiError(429, 'TOO_MANY_ATTEMPTS', { retryAfter }, { 'retry-after': String(retryAfter) });
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(ClassesService) private readonly classes: ClassesService,
    @Inject(MembershipsService) private readonly memberships: MembershipsService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(LoginRateLimiter) private readonly limiter: LoginRateLimiter,
    @Inject(TurnstileGate) private readonly turnstile: TurnstileGate,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(CommonPasswords) private readonly common: CommonPasswords,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** P1 : compte + demande d'adhésion + session dans une seule transaction (§ 0.3, R3). */
  async register(actor: AnonymousActor, body: RegisterBody, ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.register');
    const t = await this.turnstile.check(body.turnstileToken, actor.ip);
    if (t === 'unavailable') throw new ApiError(503, 'SIGNUP_UNAVAILABLE', {}, { 'retry-after': String(SIGNUP_RETRY_AFTER_SECONDS) });
    if (t === 'invalid') throw new ApiError(400, 'TURNSTILE_FAILED');
    const pw = validateNewPassword(body.password, 'USER', this.common);
    if (!pw.ok) throw new ApiError(400, pw.code);
    const passwordHash = await this.hasher.hash(pw.normalized);
    const userId = uuidv7();
    try {
      return await this.prisma.withTx(async (tx) => {
        // Ordre global des verrous : classes (FOR SHARE), puis users, puis enrollment_requests, puis sessions.
        await this.classes.lockActiveForEnrollmentInTx(tx, actor, body.classId);
        await this.users.createStudentInTx(tx, actor, { id: userId, email: body.email, firstName: body.firstName, lastName: body.lastName, passwordHash });
        const enrollmentRequestId = await this.memberships.createRequestInTx(tx, actor, { userId, classId: body.classId });
        await this.audit.recordInTx(tx, actor, { action: 'ACCOUNT_REGISTERED', targetType: 'USER', targetId: userId, metadata: { classId: body.classId, enrollmentRequestId } });
        return this.sessions.openInTx(tx, actor, { id: userId, globalRole: 'USER' }, ctx);
      });
    } catch (e) {
      // Arbitrage N : l'inscription peut révéler qu'un compte existe ; Turnstile et la limitation réduisent l'énumération.
      if (isUniqueViolation(e)) throw new ApiError(409, 'EMAIL_TAKEN');
      throw e;
    }
  }

  /** P2 : message identique dans tous les cas ; hachage factice ; suspension signalée après un mot de passe correct. */
  async login(actor: AnonymousActor, body: LoginBody, ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.login');
    const keys = this.limiter.keys(actor.ip, body.email);
    const degraded = this.turnstile.isDegraded();
    const gate = await this.limiter.check(keys, degraded);
    if (gate.kind === 'limited') throw tooManyAttempts(gate.retryAfterSeconds);
    if (gate.turnstileRequired) {
      const t = await this.turnstile.check(body.turnstileToken, actor.ip);
      if (t === 'invalid') throw new ApiError(401, 'TURNSTILE_REQUIRED', { turnstileRequired: true });
      // Erreur isolée, mode dégradé pas encore atteint : on refuse plutôt que de laisser passer sans CAPTCHA.
      if (t === 'unavailable' && !this.turnstile.isDegraded()) throw new ApiError(401, 'TURNSTILE_REQUIRED', { turnstileRequired: true });
      // 'unavailable' avec mode dégradé : les limites réduites s'appliquent aux tentatives suivantes.
    }
    const password = normalizePassword(body.password);
    const user = await this.users.findForLogin(actor, body.email);
    const ok = user?.passwordHash ? await this.hasher.verify(user.passwordHash, password) : await this.hasher.verifyDummy(password);
    if (!user || !ok) {
      const { turnstileRequired } = await this.limiter.recordFailure(keys, degraded);
      throw new ApiError(401, 'INVALID_CREDENTIALS', { turnstileRequired });
    }
    await this.limiter.recordSuccess(keys);
    if (user.status === 'SUSPENDED') throw new ApiError(403, 'ACCOUNT_SUSPENDED');
    if (user.globalRole === 'ADMIN') throw new ApiError(403, 'ADMIN_SECOND_FACTOR_REQUIRED'); // R2 : code par email au lot 1b
    return this.prisma.withTx((tx) => this.sessions.openInTx(tx, actor, { id: user.id, globalRole: 'USER' }, ctx));
  }

  async logout(actor: UserActor): Promise<void> {
    this.authz.assert(actor, 'auth.logout');
    await this.sessions.logout(actor);
  }

  /** P10 : mot de passe actuel vérifié (R6 : un échec compte pour IP + compte, R15 : 400), autres sessions révoquées. */
  async changePassword(actor: UserActor, body: ChangePasswordBody, ctx: ClientContext): Promise<void> {
    this.authz.assert(actor, 'me.changePassword');
    const pw = validateNewPassword(body.newPassword, actor.globalRole, this.common);
    if (!pw.ok) throw new ApiError(400, pw.code);
    const user = await this.users.credentialsOf(actor);
    const keys = this.limiter.keys(ctx.ip, user.email);
    const degraded = this.turnstile.isDegraded();
    const gate = await this.limiter.check(keys, degraded);
    if (gate.kind === 'limited') throw tooManyAttempts(gate.retryAfterSeconds);
    const current = normalizePassword(body.currentPassword);
    const ok = user.passwordHash ? await this.hasher.verify(user.passwordHash, current) : await this.hasher.verifyDummy(current);
    if (!ok) {
      await this.limiter.recordFailure(keys, degraded);
      throw new ApiError(400, 'CURRENT_PASSWORD_INVALID');
    }
    await this.limiter.recordSuccess(keys);
    const passwordHash = await this.hasher.hash(pw.normalized);
    await this.prisma.withTx(async (tx) => {
      await this.users.setPasswordHashInTx(tx, actor, passwordHash);
      const revokedSessions = await this.sessions.revokeOthersInTx(tx, actor, 'PASSWORD_CHANGED');
      await this.sessions.markReauthInTx(tx, actor);
      await this.audit.recordInTx(tx, actor, { action: 'PASSWORD_CHANGED', targetType: 'USER', targetId: actor.userId, metadata: { revokedSessions } });
    });
  }
}
