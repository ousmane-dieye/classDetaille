import { createHash, createHmac, randomBytes } from 'node:crypto';
import { type ForgotPasswordBody, type ResetPasswordBody } from '@classepulse/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/load-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import { ipPrefix } from '../../http/ip.js';
import { tooManyAttempts } from '../../http/too-many-attempts.js';
import { AuditService } from '../audit/audit.service.js';
import type { AnonymousActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { MailService } from '../mail/mail.service.js';
import { CommonPasswords } from '../users/common-passwords.js';
import { PasswordHasher } from '../users/password-hasher.js';
import { validateNewPassword } from '../users/password-policy.js';
import { UsersService } from '../users/users.service.js';
import type { ClientContext } from './client-context.js';
import { BUCKET_ROW_CAP } from './login-rate-limiter.js';
import { PasswordResetRepository } from './password-reset.repository.js';
import { RateLimitRepository } from './rate-limit.repository.js';
import { SecondFactorService } from './second-factor/second-factor.service.js';
import { SessionsService } from './sessions.service.js';
import { TurnstileGate } from './turnstile.js';

const HOUR = 3600;
export const RESET_REQUESTS_PER_IP_HOUR = 10;
export const RESET_REQUESTS_PER_ACCOUNT_HOUR = 3;
const RESET_TTL_SECONDS = 1800;

const hashToken = (token: string): Buffer => createHash('sha256').update(Buffer.from(token, 'base64url')).digest();

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger('PasswordResetService');
  private capWarned = false;

  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(TurnstileGate) private readonly turnstile: TurnstileGate,
    @Inject(RateLimitRepository) private readonly buckets: RateLimitRepository,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordResetRepository) private readonly repo: PasswordResetRepository,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(SecondFactorService) private readonly secondFactor: SecondFactorService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(CommonPasswords) private readonly common: CommonPasswords,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** § 3.2 : Turnstile exigé ; réponse identique que le compte soit actif, suspendu, inconnu ou limité (R9). */
  async request(actor: AnonymousActor, body: ForgotPasswordBody, ctx: ClientContext): Promise<void> {
    this.authz.assert(actor, 'auth.forgotPassword');
    const t = await this.turnstile.check(body.turnstileToken, actor.ip);
    if (t === 'unavailable') throw new ApiError(503, 'RESET_UNAVAILABLE', {}, { 'retry-after': '60' });
    if (t === 'invalid') throw new ApiError(400, 'TURNSTILE_FAILED');
    // La limite par IP s'applique toujours, même au-delà du plafond de lignes (D13) ; seul le seau par compte est suspendu.
    const ip = await this.buckets.hit(`forgot-ip:${ipPrefix(ctx.ip)}`, HOUR);
    if (ip.attempts > RESET_REQUESTS_PER_IP_HOUR) throw tooManyAttempts(Math.max(1, ip.resetIn));
    let accountAllowed = true;
    if ((await this.buckets.rowCountUpTo(BUCKET_ROW_CAP + 1, HOUR)) > BUCKET_ROW_CAP) {
      if (!this.capWarned) this.logger.warn(`alert: rate_limit_buckets above ${BUCKET_ROW_CAP} rows, per-account reset limit suspended`);
      this.capWarned = true;
    } else {
      this.capWarned = false;
      const mac = createHmac('sha256', this.config.security.rateLimitHmacKey).update(body.email).digest('hex');
      accountAllowed = (await this.buckets.hit(`forgot-acct:${mac}`, HOUR)).attempts <= RESET_REQUESTS_PER_ACCOUNT_HOUR;
    }
    const user = await this.users.findForPasswordReset(actor, body.email);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const id = uuidv7();
    const target = accountAllowed && user !== null && user.status === 'ACTIVE' ? user : null;
    await this.prisma.withTx(async (tx) => {
      if (!target) return; // R9 : l'écart de durée résiduel est accepté, les réponses restent identiques
      const locked = await this.repo.lockUserInTx(tx, target.id);
      if (!locked || locked.status !== 'ACTIVE') return;
      await this.repo.supersedeActiveInTx(tx, target.id); // une nouvelle demande annule la précédente
      await this.repo.insertInTx(tx, { id, userId: target.id, tokenHash, ttlSeconds: RESET_TTL_SECONDS });
      await this.mail.enqueueInTx(tx, actor, {
        kind: 'PASSWORD_RESET', recipientUserId: target.id, toAddress: locked.email, dedupeKey: `password-reset:${id}`,
        payload: {}, secret: { token }, expiresInSeconds: RESET_TTL_SECONDS });
    });
  }

  /** Une règle de mot de passe refusée ne consomme pas le jeton. Ordre des verrous : users → vérifications → sessions → jeton. */
  async reset(actor: AnonymousActor, body: ResetPasswordBody): Promise<void> {
    this.authz.assert(actor, 'auth.resetPassword');
    const tokenHash = hashToken(body.token);
    const ref = await this.repo.findActive(tokenHash);
    if (!ref) throw new ApiError(400, 'RESET_TOKEN_INVALID');
    const user = await this.users.findForPasswordResetById(actor, ref.userId);
    if (!user || user.status !== 'ACTIVE') throw new ApiError(400, 'RESET_TOKEN_INVALID');
    const pw = validateNewPassword(body.newPassword, user.globalRole, this.common);
    if (!pw.ok) throw new ApiError(400, pw.code);
    const passwordHash = await this.hasher.hash(pw.normalized); // hors transaction (Argon2id est lent)
    await this.prisma.withTx(async (tx) => {
      const locked = await this.repo.lockUserInTx(tx, user.id);
      if (!locked || locked.status !== 'ACTIVE') throw new ApiError(400, 'RESET_TOKEN_INVALID');
      await this.secondFactor.endAllInTx(tx, actor, user.id);
      const revoked = await this.sessions.revokeAllInTx(tx, actor, user.id, 'PASSWORD_CHANGED');
      // Jeton en dernier ; s'il n'est plus actif, l'exception annule tout ce qui précède.
      const tokenId = await this.repo.consumeActiveInTx(tx, tokenHash);
      if (!tokenId) throw new ApiError(400, 'RESET_TOKEN_INVALID');
      await this.users.resetPasswordInTx(tx, actor, user.id, passwordHash);
      await this.audit.recordInTx(tx, actor, { action: 'PASSWORD_RESET_COMPLETED', targetType: 'USER', targetId: user.id, metadata: { revokedSessions: revoked } });
      await this.mail.enqueueInTx(tx, actor, {
        kind: 'SECURITY_ALERT', recipientUserId: user.id, toAddress: locked.email, dedupeKey: `password-reset-done:${tokenId}`,
        payload: { event: 'PASSWORD_RESET' }, expiresInSeconds: 86_400 });
    });
  }
}
