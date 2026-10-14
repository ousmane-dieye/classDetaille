import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { ConfigModule } from '../../src/config/config.module.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import type { SystemActor } from '../../src/modules/authz/actor.js';
import { AuthzModule } from '../../src/modules/authz/authz.module.js';
import { MailDeliveryService } from '../../src/modules/mail/mail-delivery.service.js';
import { MailModule } from '../../src/modules/mail/mail.module.js';
import { MailService } from '../../src/modules/mail/mail.service.js';
import { PayloadCipher } from '../../src/modules/mail/payload-cipher.js';
import { TEST_OUTBOX_KEY, testConfig } from './app.js';
import { connectAs } from './pg.js';

export const SYSTEM: SystemActor = { kind: 'system', job: 'email.send' };
export const cipher = new PayloadCipher(TEST_OUTBOX_KEY);

export async function mailTestModule(db: string) {
  const mod = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, MailModule.register(TEST_OUTBOX_KEY)],
  }).compile();
  await mod.init();
  return { mail: mod.get(MailService), delivery: mod.get(MailDeliveryService), prisma: mod.get(PrismaService), close: () => mod.close() };
}

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';
/** Insère (sous cp_app) un administrateur, une vérification LOGIN active et son email ADMIN_OTP en file. */
export async function seedChallengeEmail(db: string, code = '123456') {
  const c = await connectAs('cp_app', db);
  try {
    const userId = uuidv7();
    const email = `adm.${userId}@example.com`;
    await c.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,$2,'Awa','Diop',$3,'ADMIN')`, [userId, email, HASH]);
    const challengeId = uuidv7();
    await c.query(`insert into app.auth_challenges (id, user_id, purpose, token_hash, code_hmac, expires_at) values ($1,$2,'LOGIN',$3,$4, clock_timestamp() + interval '10 minutes')`, [challengeId, userId, randomBytes(32), randomBytes(32)]);
    const emailId = uuidv7();
    await c.query(
      `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
       values ($1,$2,$3,'ADMIN_OTP',$4,'{"purpose":"LOGIN"}'::jsonb,$5,$6,(select expires_at from app.auth_challenges where id = $7),$7)`,
      [emailId, userId, email, `otp:${challengeId}`, cipher.encrypt(emailId, { code }), randomUUID(), challengeId]);
    return { userId, email, challengeId, emailId, code };
  } finally { await c.end(); }
}

/** Email sans vérification ni destinataire (type TEST par défaut), pour la file elle-même. */
export async function seedPlainEmail(db: string, over: { kind?: string; ttl?: string } = {}) {
  const c = await connectAs('cp_app', db);
  try {
    const id = uuidv7();
    await c.query(
      `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at)
       values ($1,null,'dest@example.com',$2::app.email_kind,$3,'{}'::jsonb,null,$4, clock_timestamp() + interval '${over.ttl ?? '1 hour'}')`,
      [id, over.kind ?? 'TEST', `k:${id}`, randomUUID()]);
    return id;
  } finally { await c.end(); }
}

/** Fixe directement l'état d'un email (préparation de donnée sous cp_app : les colonnes sont accordées). */
export async function forceEmail(db: string, id: string, sets: string): Promise<void> {
  const c = await connectAs('cp_app', db);
  try { await c.query(`update app.email_outbox set ${sets} where id = $1`, [id]); } finally { await c.end(); }
}

export async function emailRow(db: string, id: string) {
  const c = await connectAs('cp_app', db);
  try {
    const r = await c.query(
      `select status, normal_attempts, ambiguous_retry_scheduled as scheduled, ambiguous_retry_claimed as claimed, payload_encrypted is not null as has_payload,
              extract(epoch from (next_attempt_at - clock_timestamp()))::int as in_seconds, accepted_at is not null as accepted
         from app.email_outbox where id = $1`, [id]);
    return r.rows[0] as { status: string; normal_attempts: number; scheduled: boolean; claimed: boolean; has_payload: boolean; in_seconds: number; accepted: boolean };
  } finally { await c.end(); }
}

export async function attemptRows(db: string, id: string) {
  const c = await connectAs('cp_app', db);
  try {
    const r = await c.query('select attempt_no, kind, outcome, smtp_code, error_code, late_outcome, late_smtp_code from app.email_attempts where email_id = $1 order by attempt_no', [id]);
    return r.rows as { attempt_no: number; kind: string; outcome: string | null; smtp_code: number | null; error_code: string | null; late_outcome: string | null; late_smtp_code: number | null }[];
  } finally { await c.end(); }
}
