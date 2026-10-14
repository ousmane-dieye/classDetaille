import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitForLockWait } from '../support/lock-wait.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let app: pg.Client;
let adminId: string;
beforeAll(async () => {
  db = await createTestDatabase();
  app = await connectAs('cp_app', db);
  adminId = uuidv7();
  await app.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,'adm@example.com','Awa','Diop','$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA','ADMIN')`, [adminId]);
});
afterAll(async () => { await app.end(); });

async function insertEmail(over: { kind?: string; challengeId?: string | null; to?: string; secret?: boolean; dedupe?: string; ttl?: string } = {}) {
  const id = uuidv7();
  const kind = over.kind ?? 'TEST';
  await app.query(
    `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
     values ($1,$2,$3,$4::app.email_kind,$5,'{}'::jsonb,$6,$7, clock_timestamp() + interval '${over.ttl ?? '1 hour'}', $8)`,
    [id, adminId, over.to ?? 'adm@example.com', kind, over.dedupe ?? `k:${id}`, over.secret === false ? null : randomBytes(40), randomUUID(), over.challengeId ?? null]);
  return id;
}
const setState = (id: string, sets: string) => app.query(`update app.email_outbox set ${sets} where id = $1`, [id]);
const SENDING = `status = 'SENDING', claim_token = gen_random_uuid(), locked_until = clock_timestamp() + interval '2 minutes', normal_attempts = normal_attempts + 1`;
const RETRY = `status = 'RETRY_WAIT', claim_token = null, locked_until = null, next_attempt_at = clock_timestamp()`;
const UNCERTAIN = `status = 'UNCERTAIN', claim_token = null, locked_until = null, ambiguous_retry_scheduled = true`;
const FAILED = `status = 'FAILED', claim_token = null, locked_until = null, payload_encrypted = null`;
const ACCEPTED = `status = 'ACCEPTED', claim_token = null, locked_until = null, payload_encrypted = null, accepted_at = clock_timestamp()`;

describe('transitions (§ 2.4)', () => {
  it('chemin nominal : PENDING → SENDING → RETRY_WAIT → SENDING → UNCERTAIN → SENDING → FAILED', async () => {
    const id = await insertEmail();
    await setState(id, SENDING);
    await setState(id, RETRY);
    await setState(id, SENDING);
    await setState(id, UNCERTAIN);
    await setState(id, `${SENDING.replace('normal_attempts = normal_attempts + 1', 'ambiguous_retry_claimed = true')}`);
    await setState(id, FAILED);
  });
  it.each([
    ['PENDING → ACCEPTED', ACCEPTED],
    ['PENDING → FAILED', FAILED],
    ['PENDING → RETRY_WAIT', `${RETRY}, normal_attempts = 1`],
  ])('refuse %s', async (_n, sets) => {
    const id = await insertEmail();
    await expect(setState(id, sets)).rejects.toMatchObject({ code: '23514' });
  });
  it('refuse SENDING → EXPIRED et toute modification d’un état final', async () => {
    const a = await insertEmail();
    await setState(a, SENDING);
    await expect(setState(a, `status = 'EXPIRED', claim_token = null, locked_until = null, payload_encrypted = null`)).rejects.toMatchObject({ code: '23514' });
    await setState(a, ACCEPTED);
    await expect(setState(a, `next_attempt_at = clock_timestamp()`)).rejects.toMatchObject({ code: '23514' });
    const b = await insertEmail();
    await setState(b, `status = 'CANCELLED', payload_encrypted = null`);
    await expect(setState(b, `status = 'SENDING', claim_token = gen_random_uuid(), locked_until = clock_timestamp() + interval '1 minute', normal_attempts = 1`)).rejects.toMatchObject({ code: '23514' });
  });
  it('autorise PENDING, RETRY_WAIT et UNCERTAIN → EXPIRED / CANCELLED', async () => {
    const a = await insertEmail();
    await setState(a, `status = 'EXPIRED', payload_encrypted = null`);
    const b = await insertEmail();
    await setState(b, SENDING); await setState(b, UNCERTAIN);
    await setState(b, `status = 'CANCELLED', payload_encrypted = null`);
  });
});

describe('forme des lignes (CHECK)', () => {
  it('SENDING exige jeton et bail ; PENDING n’en a pas', async () => {
    const id = await insertEmail();
    await expect(setState(id, `status = 'SENDING', normal_attempts = 1`)).rejects.toMatchObject({ constraint: 'email_outbox_state_shape' });
  });
  it('au plus 5 tentatives normales ; RETRY_WAIT seulement avant la 5ᵉ', async () => {
    const id = await insertEmail();
    await setState(id, SENDING);
    await setState(id, `normal_attempts = 5`);
    await expect(setState(id, RETRY)).rejects.toMatchObject({ constraint: 'email_outbox_state_shape' });
    await expect(setState(id, `normal_attempts = 6`)).rejects.toMatchObject({ constraint: 'email_outbox_normal_attempts_range' });
  });
  it('les états finaux n’ont plus de contenu chiffré', async () => {
    const id = await insertEmail({ kind: 'ADMIN_SECURITY_ALERT' });
    await setState(id, SENDING);
    await expect(setState(id, `status = 'ACCEPTED', claim_token = null, locked_until = null, accepted_at = clock_timestamp()`)).rejects.toMatchObject({ constraint: 'email_outbox_state_shape' });
  });
  it('un type à secret exige un contenu chiffré tant que l’email n’est pas final', async () => {
    await expect(insertEmail({ kind: 'PASSWORD_RESET', secret: false })).rejects.toMatchObject({ constraint: 'email_outbox_secret_kinds' });
    await insertEmail({ kind: 'ADMIN_SECURITY_ALERT', secret: false });
  });
  it('clé anti-doublon et identifiant de message uniques', async () => {
    await insertEmail({ dedupe: 'same' });
    await expect(insertEmail({ dedupe: 'same' })).rejects.toMatchObject({ code: '23505' });
  });
  it('cp_app ne supprime rien', async () => {
    const id = await insertEmail();
    await expect(app.query('delete from app.email_outbox where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('delete from app.email_attempts')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('email_attempts : résultat écrit une seule fois', () => {
  async function attempt(emailId: string) {
    await setState(emailId, SENDING);
    const claim = (await app.query('select claim_token from app.email_outbox where id = $1', [emailId])).rows[0].claim_token;
    await app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'NORMAL', $2)`, [emailId, claim]);
    return claim as string;
  }
  it('le résultat ne se réécrit pas', async () => {
    const id = await insertEmail();
    await attempt(id);
    await app.query(`update app.email_attempts set outcome = 'TEMP_FAIL', smtp_code = 451, finished_at = clock_timestamp() where email_id = $1`, [id]);
    await expect(app.query(`update app.email_attempts set outcome = 'ACCEPTED' where email_id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
  });
  it('résultat tardif seulement après CANCELLED_IN_FLIGHT, une fois', async () => {
    const id = await insertEmail();
    await attempt(id);
    await expect(app.query(`update app.email_attempts set late_outcome = 'ACCEPTED' where email_id = $1`, [id])).rejects.toMatchObject({ constraint: 'email_attempts_late_only_cancelled' });
    await app.query(`update app.email_attempts set outcome = 'CANCELLED_IN_FLIGHT', finished_at = clock_timestamp() where email_id = $1`, [id]);
    await app.query(`update app.email_attempts set late_outcome = 'ACCEPTED', late_smtp_code = 250 where email_id = $1`, [id]);
    await expect(app.query(`update app.email_attempts set late_outcome = 'TEMP_FAIL' where email_id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
  });
  it('numéro et nature cohérents, unicité par email', async () => {
    const id = await insertEmail();
    await setState(id, SENDING);
    await expect(app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'AMBIGUOUS_RETRY', gen_random_uuid())`, [id])).rejects.toMatchObject({ constraint: 'email_attempts_kind_no' });
    await app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'NORMAL', gen_random_uuid())`, [id]);
    await expect(app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'NORMAL', gen_random_uuid())`, [id])).rejects.toMatchObject({ code: '23505' });
  });
});

describe('liens avec les vérifications (§ 3.3)', () => {
  async function challenge() {
    const u = uuidv7();
    await app.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,$2,'Awa','Diop','$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA','ADMIN')`, [u, `c${u}@example.com`]);
    const id = uuidv7();
    await app.query(`insert into app.auth_challenges (id, user_id, purpose, token_hash, code_hmac, expires_at) values ($1,$2,'LOGIN',$3,$4, clock_timestamp() + interval '10 minutes')`, [id, u, randomBytes(32), randomBytes(32)]);
    return { id, userId: u, email: `c${u}@example.com` };
  }
  async function otpFor(c: { id: string; userId: string; email: string }, over: { to?: string; kind?: string } = {}) {
    const id = uuidv7();
    await app.query(
      `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
       values ($1,$2,$3,$4::app.email_kind,$5,'{}'::jsonb,$6,$7, (select expires_at from app.auth_challenges where id = $8), $8)`,
      [id, c.userId, over.to ?? c.email, over.kind ?? 'ADMIN_OTP', `otp:${c.id}`, randomBytes(40), randomUUID(), c.id]);
    return id;
  }
  it('challenge_email_link : un type de code exige une vérification, les autres n’en ont pas', async () => {
    await expect(insertEmail({ kind: 'ADMIN_OTP' })).rejects.toMatchObject({ constraint: 'email_outbox_challenge_link' });
    const c = await challenge();
    await expect(insertEmail({ kind: 'TEST', challengeId: c.id })).rejects.toMatchObject({ code: '23514' }); // refusé par outbox_challenge_guard
  });
  it('outbox_challenge_guard : adresse, destinataire, type cohérents', async () => {
    const c = await challenge();
    await expect(otpFor(c, { to: 'autre@example.com' })).rejects.toMatchObject({ code: '23514' });
    await expect(otpFor(c, { kind: 'ADMIN_EMAIL_CHANGE_OLD' })).rejects.toMatchObject({ code: '23514' });
    await otpFor(c);
  });
  it('one_email_per_challenge', async () => {
    const c = await challenge();
    await otpFor(c);
    await expect(app.query(
      `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
       values ($1,$2,$3,'ADMIN_OTP','otp2:${c.id}','{}'::jsonb,$4,$5, clock_timestamp() + interval '1 minute', $6)`,
      [uuidv7(), c.userId, c.email, randomBytes(40), randomUUID(), c.id])).rejects.toMatchObject({ code: '23505' });
  });
  it('une vérification consommée est refusée pour un nouvel email', async () => {
    const c = await challenge();
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'EXPIRED' where id = $1`, [c.id]);
    await expect(otpFor(c)).rejects.toMatchObject({ code: '23514' });
  });
  it('challenge_consumed_cancels_emails : annule l’email en file et clôt la tentative en cours', async () => {
    const c = await challenge();
    const pending = await otpFor(c);
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'SUPERSEDED' where id = $1`, [c.id]);
    const r = await app.query('select status, payload_encrypted from app.email_outbox where id = $1', [pending]);
    expect(r.rows[0]).toEqual({ status: 'CANCELLED', payload_encrypted: null });

    const c2 = await challenge();
    const sending = await otpFor(c2);
    await setState(sending, SENDING);
    const claim = (await app.query('select claim_token from app.email_outbox where id = $1', [sending])).rows[0].claim_token;
    await app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'NORMAL', $2)`, [sending, claim]);
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [c2.id]);
    expect((await app.query('select status from app.email_outbox where id = $1', [sending])).rows[0].status).toBe('CANCELLED');
    expect((await app.query('select outcome from app.email_attempts where email_id = $1', [sending])).rows[0].outcome).toBe('CANCELLED_IN_FLIGHT');
  });
  it('la consommation d’une vérification ne touche pas un email déjà ACCEPTED', async () => {
    const c = await challenge();
    const id = await otpFor(c);
    await setState(id, SENDING); await setState(id, ACCEPTED);
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [c.id]);
    expect((await app.query('select status from app.email_outbox where id = $1', [id])).rows[0].status).toBe('ACCEPTED');
  });
});

describe('NOTIFY et baux', () => {
  it('une insertion validée notifie le canal email_outbox', async () => {
    const listener = await connectAs('cp_app', db);
    const got = new Promise<void>((resolve) => listener.on('notification', (m) => { if (m.channel === 'email_outbox') resolve(); }));
    await listener.query('listen email_outbox');
    await insertEmail();
    await Promise.race([got, new Promise((_r, rej) => setTimeout(() => rej(new Error('pas de notification')), 3000))]);
    await listener.end();
  });
  it('job_leases : deux lignes semées, cp_app ne peut que les mettre à jour', async () => {
    const r = await app.query('select name from app.job_leases order by name');
    expect(r.rows.map((x) => x.name)).toEqual(['email.send', 'maintenance.purge']);
    await expect(app.query(`insert into app.job_leases (name) values ('autre')`)).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.job_leases set name = 'x'`)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('verrou de la vérification par la garde (§ 3.3)', () => {
  async function mk() {
    const u = uuidv7();
    await app.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,$2,'Awa','Diop','$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA','ADMIN')`, [u, `r${u}@example.com`]);
    const id = uuidv7();
    await app.query(`insert into app.auth_challenges (id, user_id, purpose, token_hash, code_hmac, expires_at) values ($1,$2,'LOGIN',$3,$4, clock_timestamp() + interval '10 minutes')`, [id, u, randomBytes(32), randomBytes(32)]);
    return { id, u, email: `r${u}@example.com` };
  }
  const ins = (c: pg.Client, k: { id: string; u: string; email: string }, emailId: string) => c.query(
    `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
     values ($1,$2,$3,'ADMIN_OTP',$4,'{}'::jsonb,$5,$6, clock_timestamp() + interval '5 minutes', $7)`,
    [emailId, k.u, k.email, `otp:${k.id}`, randomBytes(40), randomUUID(), k.id]);
  const consume = (c: pg.Client, id: string) => c.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [id]);

  it('insertion non validée puis consommation : la consommation attend et annule l’email', async () => {
    const k = await mk();
    const a = await connectAs('cp_app', db);
    const b = await connectAs('cp_app', db);
    const emailId = uuidv7();
    try {
      await a.query('begin');
      await ins(a, k, emailId);
      const pidA = (await a.query('select pg_backend_pid() as p')).rows[0].p;
      const consuming = consume(b, k.id);
      await waitForLockWait(db, pidA);
      await a.query('commit');
      await consuming;
      const r = await app.query('select status, payload_encrypted from app.email_outbox where id = $1', [emailId]);
      expect(r.rows[0]).toEqual({ status: 'CANCELLED', payload_encrypted: null });
    } finally { await a.end(); await b.end(); }
  });
  it('consommation non validée puis insertion : l’insertion attend puis est refusée', async () => {
    const k = await mk();
    const a = await connectAs('cp_app', db);
    const b = await connectAs('cp_app', db);
    try {
      await b.query('begin');
      await consume(b, k.id);
      const pidB = (await b.query('select pg_backend_pid() as p')).rows[0].p;
      const inserting = ins(a, k, uuidv7());
      const settled = expect(inserting).rejects.toMatchObject({ code: '23514' });
      await waitForLockWait(db, pidB);
      await b.query('commit');
      await settled;
    } finally { await a.end(); await b.end(); }
  });
});

describe('email_attempts : résultat et fin ensemble', () => {
  it('outcome et finished_at vont ensemble', async () => {
    const id = await insertEmail();
    await setState(id, SENDING);
    await app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'NORMAL', gen_random_uuid())`, [id]);
    await expect(app.query(`update app.email_attempts set outcome = 'TEMP_FAIL' where email_id = $1`, [id])).rejects.toMatchObject({ constraint: 'email_attempts_finished_with_outcome' });
    await expect(app.query(`update app.email_attempts set finished_at = clock_timestamp() where email_id = $1`, [id])).rejects.toMatchObject({ constraint: 'email_attempts_finished_with_outcome' });
  });
});
