import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG } from '../../../config/config.module.js';
import type { AppConfig } from '../../../config/load-config.js';
import type { TxClient } from '../../../database/prisma.service.js';
import { ApiError } from '../../../http/errors.js';
import { tooManyRequests } from '../../../http/too-many-attempts.js';
import { AuditService } from '../../audit/audit.service.js';
import type { Actor, AnonymousActor } from '../../authz/actor.js';
import { AuthzService } from '../../authz/authz.service.js';
import type { Action } from '../../authz/matrix.js';
import { MailService } from '../../mail/mail.service.js';
import {
  ChallengesRepository, type ChallengePurpose, type ConsumeReason, type LockedChallenge,
} from './challenges.repository.js';
import { OTP_TTL_SECONDS, challengeClearCookie, newOtpCode, otpHmac, otpMatches } from './otp.js';

export type { ChallengePurpose };
export type IssueInput = {
  userId: string; purpose: Exclude<ChallengePurpose, 'RECOVERY'>; sessionId: string | null; pendingEmail: string | null;
  tokenHash: Buffer | null; ip: string | null;
};
export type Issued = { challengeId: string; expiresInSeconds: 600; resendAfterSeconds: 60 };
export type ChallengeRef = { id: string; purpose: ChallengePurpose; sessionId: string | null; pendingEmail: string | null };
export type CheckInput = { userId: string; purpose: ChallengePurpose; code: string; challengeId?: string };
export type CheckOutcome =
  | { ok: true; challenge: ChallengeRef; companion: ChallengeRef | null }
  | { ok: false; reason: 'WRONG'; attemptsLeft: number }
  | { ok: false; reason: 'LOCKED' | 'EXPIRED' | 'BLOCKED' };

export const MAX_ATTEMPTS = 5;
const ALERT_AFTER_FAILURES = 3;
const BLOCK_AFTER_FAILURES = 10;
const LIMITS = { minute: 1, hour: 5, day: 10 } as const;

/** L'action d'autorisation de chaque usage (émission : celle de l'étape qui crée la vérification). */
const ISSUE_ACTION: Record<ChallengePurpose, Action> = {
  LOGIN: 'auth.login', RECOVERY: 'auth.verifyRecovery', STEP_UP: 'me.stepUp', EMAIL_CHANGE_OLD: 'me.changeEmailStart', EMAIL_CHANGE_NEW: 'me.changeEmailVerifyOld',
};
const CHECK_ACTION: Record<ChallengePurpose, Action> = {
  LOGIN: 'auth.verifyCode', RECOVERY: 'auth.verifyRecovery', STEP_UP: 'me.stepUpVerify', EMAIL_CHANGE_OLD: 'me.changeEmailVerifyOld', EMAIL_CHANGE_NEW: 'me.changeEmailVerifyNew',
};

const ref = (c: LockedChallenge): ChallengeRef => ({ id: c.id, purpose: c.purpose, sessionId: c.sessionId, pendingEmail: c.pendingEmail });
const hourKey = (): string => new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');

/** Erreur HTTP d'un échec de vérification (R4). `clearChallengeCookie` : seulement pour les parcours qui portent le cookie de connexion. */
export function outcomeToError(o: Exclude<CheckOutcome, { ok: true }>, opts: { clearChallengeCookie: boolean }): ApiError {
  const headers: Record<string, string> = opts.clearChallengeCookie ? { 'set-cookie': challengeClearCookie() } : {};
  switch (o.reason) {
    case 'WRONG': return new ApiError(400, 'CODE_INVALID', { attemptsLeft: o.attemptsLeft });
    case 'LOCKED': return new ApiError(400, 'CODE_LOCKED', {}, headers);
    case 'EXPIRED': return new ApiError(400, 'CHALLENGE_EXPIRED', {}, headers);
    case 'BLOCKED': return new ApiError(403, 'SECOND_FACTOR_BLOCKED', {}, headers);
  }
}

@Injectable()
export class SecondFactorService {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(ChallengesRepository) private readonly repo: ChallengesRepository,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Crée une vérification et met son email en file, dans la transaction de l'appelant. Ordre : verrou `users`, limites
   * (comptées sous ce verrou, donc atomiques), consommation de l'ancienne, insertion, email.
   */
  async issueInTx(tx: TxClient, actor: Actor, input: IssueInput): Promise<Issued> {
    this.authz.assert(actor, ISSUE_ACTION[input.purpose]);
    const u = await this.repo.lockUserInTx(tx, input.userId);
    if (!u || u.status !== 'ACTIVE' || u.role !== 'ADMIN') throw new ApiError(400, 'CHALLENGE_EXPIRED');
    if (u.blockedAt) throw new ApiError(403, 'SECOND_FACTOR_BLOCKED');
    // R21 : EMAIL_CHANGE_NEW n'entre pas dans la limite des demandes (elle suit l'ancienne adresse), mais l'adresse est choisie
    // par le demandeur : plafond propre pour qu'un tiers ne reçoive pas un flot de codes.
    if (input.purpose === 'EMAIL_CHANGE_NEW') {
      const n = await this.repo.newAddressCountsInTx(tx, u.id);
      const wait = Math.max(n.hour >= LIMITS.hour ? n.retryHour : 0, n.day >= LIMITS.day ? n.retryDay : 0);
      if (wait > 0) throw tooManyRequests('TOO_MANY_CODE_REQUESTS', wait);
    } else {
      const n = await this.repo.requestCountsInTx(tx, u.id);
      const wait = Math.max(
        n.minute >= LIMITS.minute ? n.retryMinute : 0, n.hour >= LIMITS.hour ? n.retryHour : 0, n.day >= LIMITS.day ? n.retryDay : 0);
      if (wait > 0) throw tooManyRequests('TOO_MANY_CODE_REQUESTS', wait);
    }
    await this.repo.supersedeActiveInTx(tx, u.id, input.purpose);
    // D10 : une nouvelle demande de changement annule le code en attente vers l'adresse précédemment choisie (son email,
    // lié à cette vérification, n'est plus envoyé par le worker : challengeStillActive).
    if (input.purpose === 'EMAIL_CHANGE_OLD') await this.repo.supersedeActiveInTx(tx, u.id, 'EMAIL_CHANGE_NEW');
    const id = uuidv7(); // généré avant le calcul du HMAC (§ 3.3)
    const code = newOtpCode();
    await this.repo.insertInTx(tx, {
      id, userId: u.id, purpose: input.purpose, sessionId: input.sessionId, tokenHash: input.tokenHash,
      codeHmac: otpHmac(this.config.security.otpPepper, id, code), pendingEmail: input.pendingEmail, ip: input.ip, ttlSeconds: OTP_TTL_SECONDS,
    });
    const base = { recipientUserId: u.id, dedupeKey: `otp:${id}`, challengeId: id, secret: { code } } as const;
    if (input.purpose === 'EMAIL_CHANGE_NEW') {
      await this.mail.enqueueInTx(tx, actor, { ...base, kind: 'ADMIN_EMAIL_CHANGE_NEW', toAddress: input.pendingEmail!, payload: {} });
    } else if (input.purpose === 'EMAIL_CHANGE_OLD') {
      await this.mail.enqueueInTx(tx, actor, { ...base, kind: 'ADMIN_EMAIL_CHANGE_OLD', toAddress: u.email, payload: { newEmail: input.pendingEmail! } });
    } else {
      await this.mail.enqueueInTx(tx, actor, { ...base, kind: 'ADMIN_OTP', toAddress: u.email, payload: { purpose: input.purpose } });
    }
    return { challengeId: id, expiresInSeconds: 600, resendAfterSeconds: 60 };
  }

  /**
   * Étapes 1 à 4 du § 3.3. Un échec n'est jamais une exception : la transaction de l'appelant doit être validée pour que
   * l'essai, l'échec, le blocage et les alertes soient enregistrés ; l'appelant lève ensuite `outcomeToError`.
   * Toute la séquence se déroule sous `users FOR NO KEY UPDATE` : une seule vérification à la fois par administrateur,
   * donc essais, échecs et seuils sont comptés sans course.
   */
  async checkInTx(tx: TxClient, actor: Actor, input: CheckInput): Promise<CheckOutcome> {
    this.authz.assert(actor, CHECK_ACTION[input.purpose]);
    const u = await this.repo.lockUserInTx(tx, input.userId);
    if (!u || u.status !== 'ACTIVE' || u.role !== 'ADMIN') return { ok: false, reason: 'EXPIRED' };
    if (u.blockedAt) return { ok: false, reason: 'BLOCKED' }; // refus sans comparaison
    const locked = await this.repo.lockForCheckInTx(tx, u.id, input.purpose, input.challengeId ?? null);
    const target = locked.find((c) => c.purpose === input.purpose);
    // RECOVERY : seulement avec la vérification LOGIN du cookie, verrouillée avant elle.
    const companion = input.purpose === 'RECOVERY' ? locked.find((c) => c.purpose === 'LOGIN' && c.id === input.challengeId) : undefined;
    if (!target || (input.purpose === 'RECOVERY' && !companion)) return { ok: false, reason: 'EXPIRED' };
    if (target.attempts >= MAX_ATTEMPTS) {
      await this.repo.consumeInTx(tx, target.id, 'LOCKED');
      return { ok: false, reason: 'LOCKED' };
    }
    if (otpMatches(target.codeHmac, this.config.security.otpPepper, target.id, input.code)) {
      return { ok: true, challenge: ref(target), companion: companion ? ref(companion) : null };
    }
    const attempts = await this.repo.incrementAttemptsInTx(tx, target.id);
    await this.repo.insertFailureInTx(tx, u.id, target.id, input.purpose);
    const failures = await this.repo.countFailuresInTx(tx, u.id);
    if (attempts >= MAX_ATTEMPTS) await this.repo.consumeInTx(tx, target.id, 'LOCKED');
    if (failures >= ALERT_AFTER_FAILURES) await this.alertAdminsInTx(tx, actor, u.email, 'SECOND_FACTOR_FAILURES', u.id, failures);
    if (failures >= BLOCK_AFTER_FAILURES && (await this.repo.setBlockedInTx(tx, u.id))) {
      await this.audit.recordInTx(tx, actor, { action: 'ADMIN_SECOND_FACTOR_BLOCKED', targetType: 'USER', targetId: u.id, metadata: { failures } });
      await this.repo.consumeAllActiveInTx(tx, u.id, 'LOCKED');
      await this.alertAdminsInTx(tx, actor, u.email, 'SECOND_FACTOR_BLOCKED', u.id, failures);
      return { ok: false, reason: 'BLOCKED' };
    }
    return attempts >= MAX_ATTEMPTS ? { ok: false, reason: 'LOCKED' } : { ok: false, reason: 'WRONG', attemptsLeft: MAX_ATTEMPTS - attempts };
  }

  /** Alerte les autres administrateurs actifs (§ 3.3, changement d'email) ; le compte concerné n'est pas destinataire. */
  async notifyOtherAdminsInTx(tx: TxClient, actor: Actor, p: { accountId: string; accountEmail: string; dedupePart: string }): Promise<void> {
    this.authz.assert(actor, 'me.changeEmailVerifyNew');
    for (const admin of await this.repo.activeAdminsInTx(tx)) {
      if (admin.id === p.accountId) continue;
      await this.mail.enqueueInTx(tx, actor, {
        kind: 'ADMIN_SECURITY_ALERT', recipientUserId: admin.id, toAddress: admin.email,
        dedupeKey: `admin-email-alert:${p.dedupePart}:${admin.id}`,
        payload: { event: 'EMAIL_CHANGED', accountEmail: p.accountEmail }, expiresInSeconds: 86_400,
      });
    }
  }

  async consumeInTx(tx: TxClient, actor: Actor, challenge: ChallengeRef, reason: ConsumeReason): Promise<void> {
    this.authz.assert(actor, CHECK_ACTION[challenge.purpose]);
    await this.repo.consumeInTx(tx, challenge.id, reason);
  }

  async findLoginChallenge(actor: AnonymousActor, tokenHash: Buffer): Promise<{ challengeId: string; userId: string } | null> {
    this.authz.assert(actor, 'auth.verifyCode');
    const r = await this.repo.findLoginByTokenHash(tokenHash);
    return r ? { challengeId: r.id, userId: r.userId } : null;
  }

  /** Alerte à l'administrateur concerné et aux autres (§ 3.3) ; clé anti-doublon par compte, heure UTC et destinataire (R7). */
  private async alertAdminsInTx(tx: TxClient, actor: Actor, accountEmail: string, event: 'SECOND_FACTOR_FAILURES' | 'SECOND_FACTOR_BLOCKED', accountId: string, failures: number): Promise<void> {
    const prefix = event === 'SECOND_FACTOR_BLOCKED' ? 'admin-2fa-block' : 'admin-2fa-alert';
    for (const admin of await this.repo.activeAdminsInTx(tx)) {
      await this.mail.enqueueInTx(tx, actor, {
        kind: 'ADMIN_SECURITY_ALERT', recipientUserId: admin.id, toAddress: admin.email,
        dedupeKey: `${prefix}:${accountId}:${hourKey()}:${admin.id}`,
        payload: event === 'SECOND_FACTOR_FAILURES' ? { event, accountEmail, failures } : { event, accountEmail },
        expiresInSeconds: 86_400,
      });
    }
  }
}
