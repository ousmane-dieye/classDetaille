import { Inject, Injectable } from '@nestjs/common';
import { normalizePassword, type ChangePasswordBody, type LoginBody, type RegisterBody, type VerifyCodeBody, type VerifyRecoveryBody } from '@classepulse/shared';
import { v7 as uuidv7 } from 'uuid';
import { isUniqueViolation } from '../../database/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import { tooManyAttempts } from '../../http/too-many-attempts.js';
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
import { OtpLimiter } from './second-factor/otp-limiter.js';
import { hashChallengeToken, newChallengeToken } from './second-factor/otp.js';
import { SecondFactorService, outcomeToError } from './second-factor/second-factor.service.js';
import { SessionsService, type OpenedSession } from './sessions.service.js';
import { TurnstileGate } from './turnstile.js';

export type AdminCodeSent = { cookieToken: string; expiresInSeconds: 600; resendAfterSeconds: 60 };
export type LoginResult = { kind: 'session'; opened: OpenedSession } | { kind: 'second-factor'; sent: AdminCodeSent };

/** Nouvel essai de Turnstile 60 s après l'entrée en mode dégradé (R7). */
const SIGNUP_RETRY_AFTER_SECONDS = 60;

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
    @Inject(SecondFactorService) private readonly secondFactor: SecondFactorService,
    @Inject(OtpLimiter) private readonly otpLimiter: OtpLimiter,
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
  async login(actor: AnonymousActor, body: LoginBody, ctx: ClientContext): Promise<LoginResult> {
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
    if (user.globalRole === 'ADMIN') {
      await this.otpLimiter.hitRequest(ctx.ip);
      return { kind: 'second-factor', sent: await this.issueLoginCode(actor, user.id, ctx) };
    }
    return { kind: 'session', opened: await this.prisma.withTx((tx) => this.sessions.openInTx(tx, actor, { id: user.id, globalRole: 'USER' }, ctx)) };
  }

  /** Mot de passe correct, administrateur (ou renvoi) : une vérification LOGIN et son email (§ 3.3). Aucun accès tant que le code n'est pas saisi. */
  private async issueLoginCode(actor: AnonymousActor, userId: string, ctx: ClientContext): Promise<AdminCodeSent> {
    const challenge = newChallengeToken();
    const issued = await this.prisma.withTx((tx) => this.secondFactor.issueInTx(tx, actor, { userId, purpose: 'LOGIN', sessionId: null, pendingEmail: null, tokenHash: challenge.hash, ip: ctx.ip }));
    return { cookieToken: challenge.token, expiresInSeconds: issued.expiresInSeconds, resendAfterSeconds: issued.resendAfterSeconds };
  }

  /** Cookie de vérification absent, mal formé, inconnu, expiré ou consommé : toujours la même erreur, cookie effacé. */
  private async loginChallengeOf(actor: AnonymousActor, cookieToken: string | undefined) {
    const hash = cookieToken ? hashChallengeToken(cookieToken) : null;
    const found = hash ? await this.secondFactor.findLoginChallenge(actor, hash) : null;
    if (!found) throw outcomeToError({ ok: false, reason: 'EXPIRED' }, { clearChallengeCookie: true });
    return found;
  }

  async verifyCode(actor: AnonymousActor, body: VerifyCodeBody, cookieToken: string | undefined, ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.verifyCode');
    await this.otpLimiter.hitTry(ctx.ip);
    const ref = await this.loginChallengeOf(actor, cookieToken);
    const outcome = await this.prisma.withTx(async (tx) => {
      const r = await this.secondFactor.checkInTx(tx, actor, { userId: ref.userId, purpose: 'LOGIN', code: body.code, challengeId: ref.challengeId });
      if (!r.ok) return r; // valider la transaction : essai, échec, blocage et alertes sont enregistrés
      await this.secondFactor.consumeInTx(tx, actor, r.challenge, 'USED');
      const opened = await this.sessions.openAdminInTx(tx, actor, { id: ref.userId }, 'EMAIL_CODE', ctx);
      await this.audit.recordInTx(tx, actor, { action: 'ADMIN_LOGIN', targetType: 'USER', targetId: ref.userId, metadata: { method: 'EMAIL_CODE' } });
      return { ok: true as const, opened };
    });
    if (!outcome.ok) throw outcomeToError(outcome, { clearChallengeCookie: outcome.reason !== 'WRONG' });
    return outcome.opened;
  }

  /** Seulement avec un cookie LOGIN valide, donc après le mot de passe. LOGIN puis RECOVERY, consommés atomiquement (§ 3.3). */
  async verifyRecovery(actor: AnonymousActor, body: VerifyRecoveryBody, cookieToken: string | undefined, ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.verifyRecovery');
    await this.otpLimiter.hitTry(ctx.ip);
    const ref = await this.loginChallengeOf(actor, cookieToken);
    const outcome = await this.prisma.withTx(async (tx) => {
      const r = await this.secondFactor.checkInTx(tx, actor, { userId: ref.userId, purpose: 'RECOVERY', code: body.recoveryCode, challengeId: ref.challengeId });
      if (!r.ok) return r;
      await this.secondFactor.consumeInTx(tx, actor, r.companion!, 'USED'); // LOGIN d'abord
      await this.secondFactor.consumeInTx(tx, actor, r.challenge, 'USED');
      const opened = await this.sessions.openAdminInTx(tx, actor, { id: ref.userId }, 'RECOVERY_CODE', ctx);
      await this.audit.recordInTx(tx, actor, { action: 'ADMIN_LOGIN', targetType: 'USER', targetId: ref.userId, metadata: { method: 'RECOVERY_CODE' } });
      return { ok: true, opened } as const;
    });
    if (!outcome.ok) throw outcomeToError(outcome, { clearChallengeCookie: outcome.reason !== 'WRONG' });
    return outcome.opened;
  }

  async resendCode(actor: AnonymousActor, cookieToken: string | undefined, ctx: ClientContext): Promise<AdminCodeSent> {
    this.authz.assert(actor, 'auth.resendCode');
    await this.otpLimiter.hitRequest(ctx.ip);
    const ref = await this.loginChallengeOf(actor, cookieToken);
    return this.issueLoginCode(actor, ref.userId, ctx);
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
