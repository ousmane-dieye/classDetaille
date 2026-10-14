import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { SECURITY_KINDS, type EmailKind } from './email-kinds.js';
import { MAX_NORMAL_ATTEMPTS, type Decision, type SendKind } from './outbox-policy.js';

export type SendResult = { kind: SendKind; smtpCode: number | null; response: string | null; errorCode: string | null };
export type NewEmail = {
  id: string; kind: EmailKind; recipientUserId: string | null; toAddress: string; dedupeKey: string;
  payload: Record<string, unknown>; payloadEncrypted: Buffer | null; messageId: string;
  /** Avec une vérification, l'expiration de l'email est celle de la vérification (outbox_challenge_guard). */
  challengeId: string | null; expiresInSeconds: number | null;
};
export type ReservedEmail = {
  id: string; kind: EmailKind; toAddress: string; messageId: string; payload: Record<string, unknown>;
  payloadEncrypted: Buffer | null; challengeId: string | null; normalAttempts: number; retryClaimed: boolean; claimToken: string;
};
type ReservedRow = {
  id: string; kind: EmailKind; to_address: string; message_id: string; payload: Record<string, unknown>;
  payload_encrypted: Uint8Array | null; challenge_id: string | null; normal_attempts: number; ambiguous_retry_claimed: boolean;
};

const SECURITY_LIST = [...SECURITY_KINDS] as string[];
const clip = (s: string | null): string | null => (s === null ? null : s.slice(0, 200));

@Injectable()
export class OutboxRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** `null` si la clé anti-doublon existe déjà. L'expiration vient de la vérification liée, sinon de `expiresInSeconds`. */
  async insertInTx(tx: TxClient, e: NewEmail): Promise<string | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
      select ${e.id}::uuid, ${e.recipientUserId}::uuid, ${e.toAddress}, ${e.kind}::app.email_kind, ${e.dedupeKey}, ${JSON.stringify(e.payload)}::jsonb,
             ${e.payloadEncrypted}, ${e.messageId},
             coalesce((select c.expires_at from app.auth_challenges c where c.id = ${e.challengeId}::uuid),
                      clock_timestamp() + make_interval(secs => ${e.expiresInSeconds}::double precision)),
             ${e.challengeId}::uuid
      on conflict (dedupe_key) do nothing
      returning id`;
    return rows[0]?.id ?? null;
  }

  /**
   * Réservation : UNE instruction (§ 2.4). Le droit à une tentative (au plus 5 normales, une seule reprise ambiguë) est
   * vérifié à la sélection puis de nouveau dans l'UPDATE ; la tentative est créée dans la même instruction, liée au jeton.
   */
  async reserve(batch: number, leaseSeconds: number): Promise<ReservedEmail[]> {
    const claim = randomUUID();
    const rows = await this.prisma.client.$queryRaw<ReservedRow[]>`
      with cand as (
        select o.id from app.email_outbox o
         where ((o.status in ('PENDING', 'RETRY_WAIT') and o.normal_attempts < ${MAX_NORMAL_ATTEMPTS}::int)
             or (o.status = 'UNCERTAIN' and o.ambiguous_retry_scheduled and not o.ambiguous_retry_claimed))
           and o.next_attempt_at <= clock_timestamp()
           and o.expires_at > clock_timestamp()
           and (o.kind::text = any(${SECURITY_LIST}::text[]) or not (select s.bulk_email_paused from app.ops_settings s where s.id = 1))
         order by o.next_attempt_at, o.id
         limit ${batch}::int
         for update of o skip locked),
      upd as (
        update app.email_outbox o set
               status = 'SENDING', claim_token = ${claim}::uuid,
               locked_until = clock_timestamp() + make_interval(secs => ${leaseSeconds}::double precision),
               normal_attempts = o.normal_attempts + case when o.status = 'UNCERTAIN' then 0 else 1 end,
               ambiguous_retry_claimed = o.ambiguous_retry_claimed or o.status = 'UNCERTAIN'
          from cand
         where o.id = cand.id
           and ((o.status in ('PENDING', 'RETRY_WAIT') and o.normal_attempts < ${MAX_NORMAL_ATTEMPTS}::int)
             or (o.status = 'UNCERTAIN' and o.ambiguous_retry_scheduled and not o.ambiguous_retry_claimed))
        returning o.id, o.kind, o.to_address, o.message_id, o.payload, o.payload_encrypted, o.challenge_id, o.normal_attempts, o.ambiguous_retry_claimed),
      att as (
        insert into app.email_attempts (email_id, attempt_no, kind, claim_token)
        select u.id, u.normal_attempts + case when u.ambiguous_retry_claimed then 1 else 0 end,
               (case when u.ambiguous_retry_claimed then 'AMBIGUOUS_RETRY' else 'NORMAL' end)::app.email_attempt_kind, ${claim}::uuid
          from upd u
        returning email_id)
      select u.id, u.kind, u.to_address, u.message_id, u.payload, u.payload_encrypted, u.challenge_id, u.normal_attempts, u.ambiguous_retry_claimed
        from upd u join att a on a.email_id = u.id`;
    return rows.map((r) => ({
      id: r.id, kind: r.kind, toAddress: r.to_address, messageId: r.message_id, payload: r.payload,
      payloadEncrypted: r.payload_encrypted ? Buffer.from(r.payload_encrypted) : null, challengeId: r.challenge_id,
      normalAttempts: r.normal_attempts, retryClaimed: r.ambiguous_retry_claimed, claimToken: claim,
    }));
  }

  /**
   * Finalisation conditionnelle, un seul statement (ordre email puis tentative) : `false` si l'email n'est plus à nous
   * (annulé, bail expiré puis repris). L'email ne change que s'il est SENDING sous ce jeton ET que la tentative ouverte de ce jeton existe.
   */
  async finalize(e: { id: string; claimToken: string }, d: Decision, r: SendResult): Promise<boolean> {
    const rows = await this.prisma.client.$queryRaw<{ id: bigint }[]>`
      with o as (
        update app.email_outbox set
               status = ${d.status}::app.email_status, claim_token = null, locked_until = null,
               next_attempt_at = case when ${d.delaySeconds}::int is null then next_attempt_at else clock_timestamp() + make_interval(secs => ${d.delaySeconds}::double precision) end,
               ambiguous_retry_scheduled = ambiguous_retry_scheduled or ${d.status}::text = 'UNCERTAIN',
               accepted_at = case when ${d.status}::text = 'ACCEPTED' then clock_timestamp() else null end,
               payload_encrypted = case when ${d.status}::text in ('ACCEPTED', 'FAILED') then null else payload_encrypted end
         where id = ${e.id}::uuid and claim_token = ${e.claimToken}::uuid and status = 'SENDING'
           and exists (select 1 from app.email_attempts x where x.email_id = ${e.id}::uuid and x.claim_token = ${e.claimToken}::uuid and x.outcome is null)
        returning id)
      update app.email_attempts a set finished_at = clock_timestamp(), outcome = ${r.kind}::app.email_attempt_outcome,
             smtp_code = ${r.smtpCode}::int, smtp_response = ${clip(r.response)}, error_code = ${r.errorCode}
        from o where a.email_id = o.id and a.claim_token = ${e.claimToken}::uuid and a.outcome is null
      returning a.id`;
    return rows.length === 1;
  }

  /** Résultat arrivé après une annulation en cours d'envoi : seul le code est enregistré, l'email n'est jamais réactivé. */
  async recordLateOutcome(e: { id: string; claimToken: string }, r: SendResult): Promise<void> {
    await this.prisma.client.$executeRaw`
      update app.email_attempts set late_outcome = ${r.kind}::app.email_attempt_outcome, late_smtp_code = ${r.smtpCode}::int
       where email_id = ${e.id}::uuid and claim_token = ${e.claimToken}::uuid and outcome = 'CANCELLED_IN_FLIGHT' and late_outcome is null`;
  }

  /** La vérification liée est encore active et sa session (si elle en a une) est valide ; vrai pour un email sans vérification. */
  async challengeStillActive(emailId: string): Promise<boolean> {
    const r = await this.prisma.client.$queryRaw<{ ok: boolean }[]>`
      select (o.challenge_id is null or exists (
        select 1 from app.auth_challenges c left join app.sessions s on s.id = c.session_id
         where c.id = o.challenge_id and c.consumed_at is null and c.expires_at > clock_timestamp()
           and (c.session_id is null or (s.revoked_at is null and s.idle_expires_at > clock_timestamp() and s.absolute_expires_at > clock_timestamp())))) as ok
        from app.email_outbox o where o.id = ${emailId}::uuid`;
    return r[0]?.ok === true;
  }

  /** Annule un email que nous avons réservé et que nous n'enverrons pas ; la tentative est close sans transmission. */
  async cancelSending(e: { id: string; claimToken: string }): Promise<boolean> {
    const rows = await this.prisma.client.$queryRaw<{ id: bigint }[]>`
      with o as (
        update app.email_outbox set status = 'CANCELLED', claim_token = null, locked_until = null, payload_encrypted = null
         where id = ${e.id}::uuid and claim_token = ${e.claimToken}::uuid and status = 'SENDING'
           and exists (select 1 from app.email_attempts x where x.email_id = ${e.id}::uuid and x.claim_token = ${e.claimToken}::uuid and x.outcome is null)
        returning id)
      update app.email_attempts a set outcome = 'CANCELLED_IN_FLIGHT', finished_at = clock_timestamp()
        from o where a.email_id = o.id and a.claim_token = ${e.claimToken}::uuid and a.outcome is null
      returning a.id`;
    return rows.length === 1;
  }

  /** Bail expiré : tentative AMBIGUOUS/LEASE_EXPIRED, puis règle ambiguë (UNCERTAIN +15 min, ou FAILED si la reprise a déjà eu lieu). */
  async sweepExpiredLeases(limit: number): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      with exp as (
        select id, claim_token, ambiguous_retry_claimed from app.email_outbox
         where status = 'SENDING' and locked_until < clock_timestamp()
         order by locked_until limit ${limit}::int for update skip locked),
      o as (
        update app.email_outbox o set
               status = (case when exp.ambiguous_retry_claimed then 'FAILED' else 'UNCERTAIN' end)::app.email_status,
               claim_token = null, locked_until = null,
               ambiguous_retry_scheduled = o.ambiguous_retry_scheduled or not exp.ambiguous_retry_claimed,
               next_attempt_at = case when exp.ambiguous_retry_claimed then o.next_attempt_at else clock_timestamp() + interval '15 minutes' end,
               payload_encrypted = case when exp.ambiguous_retry_claimed then null else o.payload_encrypted end
          from exp where o.id = exp.id and o.status = 'SENDING' and o.claim_token = exp.claim_token and o.locked_until < clock_timestamp()
        returning o.id, exp.claim_token as old_claim)
      update app.email_attempts a set outcome = 'AMBIGUOUS', error_code = 'LEASE_EXPIRED', finished_at = clock_timestamp()
        from o where a.email_id = o.id and a.claim_token = o.old_claim and a.outcome is null
      returning o.id`;
    return rows.length;
  }

  async expireOverdue(limit: number): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      with e as (
        select id from app.email_outbox
         where status in ('PENDING', 'RETRY_WAIT', 'UNCERTAIN') and expires_at <= clock_timestamp()
         order by expires_at limit ${limit}::int for update skip locked)
      update app.email_outbox o set status = 'EXPIRED', payload_encrypted = null from e where o.id = e.id returning o.id`;
    return rows.length;
  }
}
