import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import type { ClientContext } from './client-context.js';
import { CredentialsChecker } from './credentials-checker.js';
import { OtpLimiter } from './second-factor/otp-limiter.js';
import { SecondFactorService, outcomeToError, type CheckOutcome } from './second-factor/second-factor.service.js';
import { SessionsRepository } from './sessions.repository.js';

@Injectable()
export class StepUpService {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(CredentialsChecker) private readonly credentials: CredentialsChecker,
    @Inject(SecondFactorService) private readonly sf: SecondFactorService,
    @Inject(OtpLimiter) private readonly otpLimiter: OtpLimiter,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** Ressaisie du mot de passe : autorise pendant 5 min les actions sensibles qui n'exigent pas de code (§ 3.3, R11). */
  async reauth(actor: UserActor, password: string, ctx: ClientContext): Promise<void> {
    this.authz.assert(actor, 'me.reauth');
    await this.credentials.verifyOrThrow(actor, password, ctx);
    await this.prisma.withTx((tx) => this.sessions.markReauthInTx(tx, actor.sessionId));
  }

  /** Étape 1 : mot de passe (ressaisie) puis code envoyé à l'adresse, lié à la session. */
  async startStepUp(actor: UserActor, password: string, ctx: ClientContext): Promise<{ expiresInSeconds: 600 }> {
    this.authz.assert(actor, 'me.stepUp');
    await this.credentials.verifyOrThrow(actor, password, ctx);
    await this.otpLimiter.hitRequest(ctx.ip);
    await this.prisma.withTx(async (tx) => {
      // Ordre des verrous (§ 3.4) : users (dans issueInTx), vérifications, puis sessions.
      await this.sf.issueInTx(tx, actor, { userId: actor.userId, purpose: 'STEP_UP', sessionId: actor.sessionId, pendingEmail: null, tokenHash: null, ip: ctx.ip });
      await this.sessions.markReauthInTx(tx, actor.sessionId);
    });
    return { expiresInSeconds: 600 };
  }

  /** Étape 2 : le code doit appartenir à la session de la requête ; sinon CHALLENGE_EXPIRED, sans consommer la vérification d'une autre session. */
  async verifyStepUp(actor: UserActor, code: string, ctx: ClientContext): Promise<void> {
    this.authz.assert(actor, 'me.stepUpVerify');
    await this.otpLimiter.hitTry(ctx.ip);
    const outcome = await this.prisma.withTx(async (tx): Promise<CheckOutcome> => {
      const r = await this.sf.checkInTx(tx, actor, { userId: actor.userId, purpose: 'STEP_UP', code });
      if (!r.ok) return r; // la transaction est validée : l'essai et l'échec sont enregistrés
      if (r.challenge.sessionId !== actor.sessionId) return { ok: false, reason: 'EXPIRED' };
      await this.sf.consumeInTx(tx, actor, r.challenge, 'USED');
      if (!(await this.sessions.markStepUpInTx(tx, actor.sessionId))) return { ok: false, reason: 'EXPIRED' };
      return r;
    });
    if (!outcome.ok) throw outcomeToError(outcome, { clearChallengeCookie: false });
  }
}
