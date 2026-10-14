import type { EmailChangeStartBody } from '@classepulse/shared';
import { Inject, Injectable } from '@nestjs/common';
import { isUniqueViolation } from '../../database/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { MailService } from '../mail/mail.service.js';
import { UsersService } from '../users/users.service.js';
import type { ClientContext } from './client-context.js';
import { CredentialsChecker } from './credentials-checker.js';
import { OtpLimiter } from './second-factor/otp-limiter.js';
import { PasswordResetRepository } from './password-reset.repository.js';
import { SecondFactorService, outcomeToError, type CheckOutcome } from './second-factor/second-factor.service.js';
import { SessionsService } from './sessions.service.js';

/** Annule la transaction de verifyNew (rien n'a changé) quand la session de la requête n'est plus valide. */
class SessionGone extends Error {}

@Injectable()
export class EmailChangeService {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(CredentialsChecker) private readonly credentials: CredentialsChecker,
    @Inject(SecondFactorService) private readonly sf: SecondFactorService,
    @Inject(OtpLimiter) private readonly otpLimiter: OtpLimiter,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PasswordResetRepository) private readonly resetTokens: PasswordResetRepository,
  ) {}

  /**
   * Étape 1 : mot de passe, puis code envoyé à l'ANCIENNE adresse (`pending_email` = la nouvelle, liée à la session).
   * D10 : les emails de code en attente d'une demande précédente sont liés à leur vérification ; issueInTx la remplace
   * (SUPERSEDED), donc le worker ne les envoie plus (challengeStillActive). Les alertes ont une clé propre à la vérification.
   */
  async start(actor: UserActor, body: EmailChangeStartBody, ctx: ClientContext): Promise<{ expiresInSeconds: 600 }> {
    this.authz.assert(actor, 'me.changeEmailStart');
    await this.credentials.verifyOrThrow(actor, body.password, ctx);
    const current = await this.users.credentialsOf(actor);
    if (body.newEmail === current.email) throw new ApiError(400, 'EMAIL_UNCHANGED');
    if (await this.users.emailExists(actor, body.newEmail)) throw new ApiError(409, 'EMAIL_TAKEN');
    await this.otpLimiter.hitRequest(ctx.ip);
    await this.prisma.withTx((tx) => this.sf.issueInTx(tx, actor, {
      userId: actor.userId, purpose: 'EMAIL_CHANGE_OLD', sessionId: actor.sessionId, pendingEmail: body.newEmail, tokenHash: null, ip: ctx.ip }));
    return { expiresInSeconds: 600 };
  }

  /** Étape 2 : code de l'ancienne adresse (tient lieu de vérification supplémentaire, sans toucher `step_up_at`), puis code envoyé à la NOUVELLE. */
  async verifyOld(actor: UserActor, code: string, ctx: ClientContext): Promise<{ expiresInSeconds: 600 }> {
    this.authz.assert(actor, 'me.changeEmailVerifyOld');
    await this.otpLimiter.hitTry(ctx.ip);
    const outcome = await this.prisma.withTx(async (tx): Promise<CheckOutcome> => {
      const r = await this.sf.checkInTx(tx, actor, { userId: actor.userId, purpose: 'EMAIL_CHANGE_OLD', code });
      if (!r.ok) return r;
      if (r.challenge.sessionId !== actor.sessionId || !r.challenge.pendingEmail) return { ok: false, reason: 'EXPIRED' };
      await this.sf.consumeInTx(tx, actor, r.challenge, 'USED');
      // Un seul code par vérification de l'ancienne adresse (consommée ici) ; plafond propre dans issueInTx (R21).
      await this.sf.issueInTx(tx, actor, {
        userId: actor.userId, purpose: 'EMAIL_CHANGE_NEW', sessionId: actor.sessionId, pendingEmail: r.challenge.pendingEmail, tokenHash: null, ip: ctx.ip });
      return r;
    });
    if (!outcome.ok) throw outcomeToError(outcome, { clearChallengeCookie: false });
    return { expiresInSeconds: 600 };
  }

  /**
   * Étape 3 : code de la nouvelle adresse. Ordre des verrous : users (checkInTx), vérifications (la nôtre, puis celles des
   * autres sessions, consommées SESSION_ENDED), puis sessions (révocation des autres, puis verrou de la session courante).
   * L'ancienne adresse est lue sous le verrou users (D9). Session courante invalide : transaction annulée, CHALLENGE_EXPIRED.
   */
  async verifyNew(actor: UserActor, code: string, ctx: ClientContext): Promise<void> {
    this.authz.assert(actor, 'me.changeEmailVerifyNew');
    await this.otpLimiter.hitTry(ctx.ip);
    let outcome: CheckOutcome;
    try {
      outcome = await this.prisma.withTx(async (tx): Promise<CheckOutcome> => {
        const r = await this.sf.checkInTx(tx, actor, { userId: actor.userId, purpose: 'EMAIL_CHANGE_NEW', code });
        if (!r.ok) return r;
        const newEmail = r.challenge.pendingEmail;
        if (r.challenge.sessionId !== actor.sessionId || !newEmail) return { ok: false, reason: 'EXPIRED' };
        await this.sf.consumeInTx(tx, actor, r.challenge, 'USED');
        const revoked = await this.sessions.revokeOthersInTx(tx, actor, 'EMAIL_CHANGED');
        if (!(await this.sessions.lockCurrentValidInTx(tx, actor))) throw new SessionGone();
        const oldEmail = await this.users.changeEmailInTx(tx, actor, newEmail);
        await this.resetTokens.supersedeActiveInTx(tx, actor.userId); // un jeton demandé pour l'ancienne adresse est annulé
        await this.audit.recordInTx(tx, actor, { action: 'ADMIN_EMAIL_CHANGED', targetType: 'USER', targetId: actor.userId, metadata: { revokedSessions: revoked } });
        // L'ancienne adresse est prévenue ; les autres administrateurs aussi.
        await this.mail.enqueueInTx(tx, actor, {
          kind: 'SECURITY_ALERT', recipientUserId: actor.userId, toAddress: oldEmail, dedupeKey: `email-changed:${r.challenge.id}`,
          payload: { event: 'EMAIL_CHANGED' }, expiresInSeconds: 86_400 });
        await this.sf.notifyOtherAdminsInTx(tx, actor, { accountId: actor.userId, accountEmail: newEmail, dedupePart: r.challenge.id });
        return r;
      });
    } catch (e) {
      if (e instanceof SessionGone) throw new ApiError(400, 'CHALLENGE_EXPIRED');
      if (isUniqueViolation(e)) throw new ApiError(409, 'EMAIL_TAKEN'); // la transaction est annulée : rien n'a changé
      throw e;
    }
    if (!outcome.ok) throw outcomeToError(outcome, { clearChallengeCookie: false });
  }
}
