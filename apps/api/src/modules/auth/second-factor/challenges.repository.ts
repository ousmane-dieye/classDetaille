import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../../database/prisma.service.js';

export type ChallengePurpose = 'LOGIN' | 'RECOVERY' | 'STEP_UP' | 'EMAIL_CHANGE_OLD' | 'EMAIL_CHANGE_NEW';
export type ConsumeReason = 'USED' | 'EXPIRED' | 'SUPERSEDED' | 'LOCKED' | 'SESSION_ENDED';
export type LockedUser = { id: string; email: string; role: 'USER' | 'ADMIN'; status: string; blockedAt: Date | null };
export type NewChallenge = {
  id: string; userId: string; purpose: ChallengePurpose; sessionId: string | null; tokenHash: Buffer | null;
  codeHmac: Buffer; pendingEmail: string | null; ip: string | null; ttlSeconds: number;
};
export type LockedChallenge = { id: string; purpose: ChallengePurpose; sessionId: string | null; pendingEmail: string | null; attempts: number; codeHmac: Buffer };
export type RequestCounts = { minute: number; hour: number; day: number; retryMinute: number; retryHour: number; retryDay: number };

@Injectable()
export class ChallengesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Premier verrou de toute opération sur les vérifications (§ 3.3, étape 1). */
  async lockUserInTx(tx: TxClient, userId: string): Promise<LockedUser | null> {
    const r = await tx.$queryRaw<{ id: string; email: string; role: 'USER' | 'ADMIN'; status: string; blocked_at: Date | null }[]>`
      select id, email::text as email, global_role::text as role, status::text as status, second_factor_blocked_at as blocked_at
        from app.users where id = ${userId}::uuid for no key update`;
    const u = r[0];
    return u ? { id: u.id, email: u.email, role: u.role, status: u.status, blockedAt: u.blocked_at } : null;
  }

  /**
   * À appeler sous le verrou de l'administrateur : le comptage et l'insertion sont ainsi atomiques (R5).
   * Comptent LOGIN, STEP_UP et EMAIL_CHANGE_OLD (R21) ; ni RECOVERY ni EMAIL_CHANGE_NEW.
   */
  async requestCountsInTx(tx: TxClient, userId: string): Promise<RequestCounts> {
    const r = await tx.$queryRaw<{ m: number; h: number; d: number; rm: number | null; rh: number | null; rd: number | null }[]>`
      select count(*) filter (where created_at > clock_timestamp() - interval '1 minute')::int as m,
             count(*) filter (where created_at > clock_timestamp() - interval '1 hour')::int as h,
             count(*)::int as d,
             ceil(extract(epoch from (max(created_at) filter (where created_at > clock_timestamp() - interval '1 minute') + interval '1 minute' - clock_timestamp())))::int as rm,
             ceil(extract(epoch from (min(created_at) filter (where created_at > clock_timestamp() - interval '1 hour') + interval '1 hour' - clock_timestamp())))::int as rh,
             ceil(extract(epoch from (min(created_at) + interval '1 day' - clock_timestamp())))::int as rd
        from app.auth_challenges
       where user_id = ${userId}::uuid and purpose in ('LOGIN', 'STEP_UP', 'EMAIL_CHANGE_OLD') and created_at > clock_timestamp() - interval '1 day'`;
    const x = r[0]!;
    return { minute: x.m, hour: x.h, day: x.d, retryMinute: x.rm ?? 60, retryHour: x.rh ?? 3600, retryDay: x.rd ?? 86400 };
  }

  /**
   * Codes EMAIL_CHANGE_NEW émis pour ce compte (sous son verrou) : l'adresse est choisie par le demandeur, donc plafond
   * propre (5 par heure, 10 par jour) en plus de la borne structurelle (un seul code par vérification de l'ancienne adresse).
   */
  async newAddressCountsInTx(tx: TxClient, userId: string): Promise<{ hour: number; day: number; retryHour: number; retryDay: number }> {
    const r = await tx.$queryRaw<{ h: number; d: number; rh: number | null; rd: number | null }[]>`
      select count(*) filter (where created_at > clock_timestamp() - interval '1 hour')::int as h,
             count(*)::int as d,
             ceil(extract(epoch from (min(created_at) filter (where created_at > clock_timestamp() - interval '1 hour') + interval '1 hour' - clock_timestamp())))::int as rh,
             ceil(extract(epoch from (min(created_at) + interval '1 day' - clock_timestamp())))::int as rd
        from app.auth_challenges
       where user_id = ${userId}::uuid and purpose = 'EMAIL_CHANGE_NEW' and created_at > clock_timestamp() - interval '1 day'`;
    const x = r[0]!;
    return { hour: x.h, day: x.d, retryHour: x.rh ?? 3600, retryDay: x.rd ?? 86400 };
  }

  async supersedeActiveInTx(tx: TxClient, userId: string, purpose: ChallengePurpose): Promise<void> {
    await tx.$executeRaw`
      update app.auth_challenges
         set consumed_at = clock_timestamp(),
             consumed_reason = (case when expires_at <= clock_timestamp() then 'EXPIRED' else 'SUPERSEDED' end)::app.challenge_consumed_reason
       where user_id = ${userId}::uuid and purpose = ${purpose}::app.challenge_purpose and consumed_at is null`;
  }

  async insertInTx(tx: TxClient, c: NewChallenge): Promise<void> {
    await tx.$executeRaw`
      insert into app.auth_challenges (id, user_id, purpose, session_id, token_hash, code_hmac, pending_email, ip, expires_at)
      values (${c.id}::uuid, ${c.userId}::uuid, ${c.purpose}::app.challenge_purpose, ${c.sessionId}::uuid, ${c.tokenHash}, ${c.codeHmac},
              ${c.pendingEmail}::ext.citext, ${c.ip}::inet, clock_timestamp() + make_interval(secs => ${c.ttlSeconds}::double precision))`;
  }

  /** Lecture sans verrou : retrouve la vérification LOGIN active d'un cookie. */
  async findLoginByTokenHash(hash: Buffer): Promise<{ id: string; userId: string } | null> {
    const r = await this.prisma.client.$queryRaw<{ id: string; user_id: string }[]>`
      select id, user_id from app.auth_challenges
       where token_hash = ${hash} and purpose = 'LOGIN' and consumed_at is null and expires_at > clock_timestamp()`;
    return r[0] ? { id: r[0].id, userId: r[0].user_id } : null;
  }

  /**
   * Verrouille (FOR UPDATE) les vérifications actives utiles. Pour RECOVERY : LOGIN puis RECOVERY, dans cet ordre
   * (l'énumération `challenge_purpose` est déclarée dans l'ordre des verrous ; LockRows s'applique après le tri).
   */
  async lockForCheckInTx(tx: TxClient, userId: string, purpose: ChallengePurpose, challengeId: string | null): Promise<LockedChallenge[]> {
    const rows = purpose === 'RECOVERY'
      ? await tx.$queryRaw<LockedRow[]>`
          select id, purpose::text as purpose, session_id, pending_email::text as pending_email, attempts, code_hmac from app.auth_challenges
           where user_id = ${userId}::uuid and purpose in ('LOGIN', 'RECOVERY') and consumed_at is null and expires_at > clock_timestamp()
           order by purpose for update`
      : await tx.$queryRaw<LockedRow[]>`
          select id, purpose::text as purpose, session_id, pending_email::text as pending_email, attempts, code_hmac from app.auth_challenges
           where user_id = ${userId}::uuid and purpose = ${purpose}::app.challenge_purpose and consumed_at is null and expires_at > clock_timestamp()
             and (${challengeId}::uuid is null or id = ${challengeId}::uuid)
           for update`;
    return rows.map((r) => ({ id: r.id, purpose: r.purpose, sessionId: r.session_id, pendingEmail: r.pending_email, attempts: r.attempts, codeHmac: Buffer.from(r.code_hmac) }));
  }

  /** Un essai de plus, en une instruction ; jamais au-delà de 5 (la ligne est alors déjà verrouillée par lockForCheckInTx). */
  async incrementAttemptsInTx(tx: TxClient, id: string): Promise<number> {
    const r = await tx.$queryRaw<{ attempts: number }[]>`
      update app.auth_challenges set attempts = attempts + 1 where id = ${id}::uuid and attempts < 5 and consumed_at is null returning attempts`;
    if (!r[0]) throw new Error('challenge attempts not incremented');
    return r[0].attempts;
  }

  async consumeInTx(tx: TxClient, id: string, reason: ConsumeReason): Promise<void> {
    await tx.$executeRaw`
      update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = ${reason}::app.challenge_consumed_reason
       where id = ${id}::uuid and consumed_at is null`;
  }

  /**
   * Consomme (SESSION_ENDED) toute vérification non consommée liée à l'une de ces sessions. Ordre des verrous (§ 2.1) :
   * vérifications d'abord (verrouillées par identifiant croissant), l'appelant révoque les sessions ensuite.
   * Retourne le nombre de vérifications consommées.
   */
  async consumeBySessionsInTx(tx: TxClient, sessionIds: readonly string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const r = await tx.$queryRaw<{ id: string }[]>`
      with locked as (
        select id from app.auth_challenges
         where session_id = any(${sessionIds as string[]}::uuid[]) and consumed_at is null
         order by id for update)
      update app.auth_challenges c set consumed_at = clock_timestamp(), consumed_reason = 'SESSION_ENDED'::app.challenge_consumed_reason
        from locked where c.id = locked.id and c.consumed_at is null
      returning c.id`;
    return r.length;
  }

  async insertFailureInTx(tx: TxClient, userId: string, challengeId: string, purpose: ChallengePurpose): Promise<void> {
    await tx.$executeRaw`insert into app.second_factor_failures (user_id, challenge_id, purpose) values (${userId}::uuid, ${challengeId}::uuid, ${purpose}::app.challenge_purpose)`;
  }

  /** Échecs des 60 dernières minutes, à partir de la dernière levée du blocage (--clear-block). */
  async countFailuresInTx(tx: TxClient, userId: string): Promise<number> {
    const r = await tx.$queryRaw<{ n: number }[]>`
      select count(*)::int as n from app.second_factor_failures f join app.users u on u.id = f.user_id
       where f.user_id = ${userId}::uuid
         and f.occurred_at > greatest(clock_timestamp() - interval '60 minutes', coalesce(u.second_factor_cleared_at, '-infinity'::timestamptz))`;
    return r[0]!.n;
  }

  async setBlockedInTx(tx: TxClient, userId: string): Promise<boolean> {
    const r = await tx.$queryRaw<{ n: number }[]>`
      update app.users set second_factor_blocked_at = clock_timestamp() where id = ${userId}::uuid and second_factor_blocked_at is null returning 1 as n`;
    return r.length === 1;
  }

  /** Consomme toutes les vérifications actives du compte, sauf RECOVERY (seule sortie du blocage). */
  async consumeAllActiveInTx(tx: TxClient, userId: string, reason: ConsumeReason): Promise<void> {
    await tx.$executeRaw`
      update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = ${reason}::app.challenge_consumed_reason
       where user_id = ${userId}::uuid and purpose <> 'RECOVERY' and consumed_at is null`;
  }

  async activeAdminsInTx(tx: TxClient): Promise<{ id: string; email: string }[]> {
    return tx.$queryRaw<{ id: string; email: string }[]>`
      select id, email::text as email from app.users where status = 'ACTIVE' and global_role = 'ADMIN' order by id`;
  }
}

type LockedRow = { id: string; purpose: ChallengePurpose; session_id: string | null; pending_email: string | null; attempts: number; code_hmac: Uint8Array };
