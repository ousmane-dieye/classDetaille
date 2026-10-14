import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';

export type LockedUser = { id: string; email: string; status: string };

@Injectable()
export class PasswordResetRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Même verrou `users` que toutes les opérations d'authentification : premier de l'ordre users → vérifications → sessions → jeton. */
  async lockUserInTx(tx: TxClient, userId: string): Promise<LockedUser | null> {
    const r = await tx.$queryRaw<LockedUser[]>`select id, email::text as email, status::text as status from app.users where id = ${userId}::uuid for no key update`;
    return r[0] ?? null;
  }

  async supersedeActiveInTx(tx: TxClient, userId: string): Promise<void> {
    await tx.$executeRaw`update app.password_reset_tokens set consumed_at = clock_timestamp() where user_id = ${userId}::uuid and consumed_at is null`;
    // Le lien d'un jeton annulé est mort : l'email non parti (ni réservé ni en vol) est annulé, son contenu effacé.
    // Un email déjà réservé (SENDING) est laissé : le worker revérifie avant l'envoi. email_outbox suit les jetons dans l'ordre des verrous.
    await tx.$executeRaw`
      update app.email_outbox set status = 'CANCELLED', claim_token = null, locked_until = null, payload_encrypted = null
       where recipient_user_id = ${userId}::uuid and kind = 'PASSWORD_RESET'::app.email_kind
         and status in ('PENDING', 'RETRY_WAIT') and claim_token is null and locked_until is null`;
  }

  async insertInTx(tx: TxClient, t: { id: string; userId: string; tokenHash: Buffer; ttlSeconds: number }): Promise<void> {
    await tx.$executeRaw`
      insert into app.password_reset_tokens (id, user_id, token_hash, expires_at)
      values (${t.id}::uuid, ${t.userId}::uuid, ${t.tokenHash}, clock_timestamp() + make_interval(secs => ${t.ttlSeconds}::double precision))`;
  }

  /** Lecture sans verrou : retrouve un jeton actif (la consommation, elle, revérifie tout). */
  async findActive(tokenHash: Buffer): Promise<{ id: string; userId: string } | null> {
    const r = await this.prisma.client.$queryRaw<{ id: string; user_id: string }[]>`
      select id, user_id from app.password_reset_tokens where token_hash = ${tokenHash} and consumed_at is null and expires_at > clock_timestamp()`;
    return r[0] ? { id: r[0].id, userId: r[0].user_id } : null;
  }

  /** Usage unique : une seule instruction conditionnelle ; une transaction concurrente attend le verrou de ligne puis ne trouve plus rien. */
  async consumeActiveInTx(tx: TxClient, tokenHash: Buffer): Promise<string | null> {
    const r = await tx.$queryRaw<{ id: string }[]>`
      update app.password_reset_tokens set consumed_at = clock_timestamp()
       where token_hash = ${tokenHash} and consumed_at is null and expires_at > clock_timestamp()
      returning id`;
    return r[0]?.id ?? null;
  }
}
