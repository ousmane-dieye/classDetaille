import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';

export type RevokeReason = 'LOGOUT' | 'PASSWORD_CHANGED' | 'OTHER_DEVICES' | 'EMAIL_CHANGED' | 'SUSPENDED' | 'ANONYMIZED';
export type NewSessionRow = {
  id: string; tokenHash: Buffer; userId: string;
  idleSeconds: number; absoluteSeconds: number; ip: string | null; userAgent: string | null;
  secondFactorMethod: 'EMAIL_CODE' | 'RECOVERY_CODE' | null;
};

@Injectable()
export class SessionsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Échéances calculées par l'horloge de la base (§ 2.1) : un seul clock_timestamp() pour les deux (A9). */
  async createInTx(tx: TxClient, s: NewSessionRow): Promise<void> {
    await tx.$executeRaw`
      insert into app.sessions (id, token_hash, user_id, idle_expires_at, absolute_expires_at, ip, user_agent, second_factor_at, second_factor_method)
      select ${s.id}::uuid, ${s.tokenHash}, ${s.userId}::uuid,
             n.t + make_interval(secs => ${s.idleSeconds}::double precision),
             n.t + make_interval(secs => ${s.absoluteSeconds}::double precision),
             ${s.ip}::inet, ${s.userAgent},
             case when ${s.secondFactorMethod}::text is null then null else n.t end, ${s.secondFactorMethod}::text
        from (select clock_timestamp() as t) n`;
  }

  async findValid(tokenHash: Buffer): Promise<{ sessionId: string; userId: string; stale: boolean } | null> {
    const r = await this.prisma.client.$queryRaw<{ id: string; user_id: string; stale: boolean }[]>`
      select id, user_id, last_seen_at < clock_timestamp() - interval '5 minutes' as stale
        from app.sessions
       where token_hash = ${tokenHash} and revoked_at is null
         and idle_expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()`;
    const row = r[0];
    return row ? { sessionId: row.id, userId: row.user_id, stale: row.stale } : null;
  }

  /** Au plus toutes les 5 min (§ 3.4) ; l'inactivité ne dépasse jamais l'échéance absolue. */
  async touch(sessionId: string, idleSeconds: number): Promise<void> {
    await this.prisma.client.$executeRaw`
      update app.sessions
         set last_seen_at = clock_timestamp(),
             idle_expires_at = least(clock_timestamp() + make_interval(secs => ${idleSeconds}::double precision), absolute_expires_at)
       where id = ${sessionId}::uuid and revoked_at is null and last_seen_at < clock_timestamp() - interval '5 minutes'`;
  }

  async revoke(sessionId: string, reason: RevokeReason): Promise<void> {
    await this.prisma.client.$executeRaw`
      update app.sessions set revoked_at = clock_timestamp(), revoke_reason = ${reason}::app.session_revoke_reason
       where id = ${sessionId}::uuid and revoked_at is null`;
  }

  async revokeOthersInTx(tx: TxClient, userId: string, keepSessionId: string, reason: RevokeReason): Promise<number> {
    return tx.$executeRaw`
      update app.sessions set revoked_at = clock_timestamp(), revoke_reason = ${reason}::app.session_revoke_reason
       where user_id = ${userId}::uuid and id <> ${keepSessionId}::uuid and revoked_at is null`;
  }

  /** Verrou de la session (après les vérifications, ordre global) : vrai si elle est encore valide. */
  async lockValidInTx(tx: TxClient, sessionId: string): Promise<boolean> {
    const r = await tx.$queryRaw<{ n: number }[]>`
      select 1 as n from app.sessions
       where id = ${sessionId}::uuid and revoked_at is null and idle_expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()
         for update`;
    return r.length === 1;
  }

  async markReauthInTx(tx: TxClient, sessionId: string): Promise<void> {
    await tx.$executeRaw`update app.sessions set reauth_at = clock_timestamp() where id = ${sessionId}::uuid and revoked_at is null`;
  }

  /** Fraîcheur (moins de 5 min) du mot de passe et du code, sous `FOR SHARE` : la session ne peut pas être révoquée pendant l'action. `null` : session invalide. */
  async freshnessInTx(tx: TxClient, sessionId: string): Promise<{ password: boolean; code: boolean } | null> {
    const r = await tx.$queryRaw<{ pw: boolean; code: boolean }[]>`
      select coalesce(reauth_at > clock_timestamp() - interval '5 minutes', false) as pw,
             coalesce(step_up_at > clock_timestamp() - interval '5 minutes', false) as code
        from app.sessions
       where id = ${sessionId}::uuid and revoked_at is null and idle_expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()
         for share`;
    return r[0] ? { password: r[0].pw, code: r[0].code } : null;
  }

  async markStepUpInTx(tx: TxClient, sessionId: string): Promise<boolean> {
    const r = await tx.$queryRaw<{ n: number }[]>`
      update app.sessions set step_up_at = clock_timestamp() where id = ${sessionId}::uuid and revoked_at is null returning 1 as n`;
    return r.length === 1;
  }

  /** Révocation dans la transaction de l'appelant (après la consommation des vérifications liées, § 3.4). */
  async revokeInTx(tx: TxClient, sessionId: string, reason: RevokeReason): Promise<void> {
    await tx.$executeRaw`
      update app.sessions set revoked_at = clock_timestamp(), revoke_reason = ${reason}::app.session_revoke_reason
       where id = ${sessionId}::uuid and revoked_at is null`;
  }

  /** Sessions actives de l'utilisateur autres que celle conservée : ce que revokeOthersInTx va révoquer. */
  async otherActiveIdsInTx(tx: TxClient, userId: string, keepSessionId: string): Promise<string[]> {
    const r = await tx.$queryRaw<{ id: string }[]>`
      select id from app.sessions where user_id = ${userId}::uuid and id <> ${keepSessionId}::uuid and revoked_at is null`;
    return r.map((x) => x.id);
  }

  async listActive(userId: string): Promise<{ id: string; createdAt: Date; lastSeenAt: Date; userAgent: string | null }[]> {
    const rows = await this.prisma.client.$queryRaw<{ id: string; created_at: Date; last_seen_at: Date; user_agent: string | null }[]>`
      select id, created_at, last_seen_at, user_agent from app.sessions
       where user_id = ${userId}::uuid and revoked_at is null
         and idle_expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()
       order by last_seen_at desc`;
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, userAgent: r.user_agent }));
  }
}
