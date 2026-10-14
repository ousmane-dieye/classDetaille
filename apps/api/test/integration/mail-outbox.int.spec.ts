import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReservedEmail, SendResult } from '../../src/modules/mail/mail-delivery.service.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { SYSTEM, attemptRows, cipher, emailRow, forceEmail, mailTestModule, seedChallengeEmail, seedPlainEmail } from '../support/mail.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let m: Awaited<ReturnType<typeof mailTestModule>>;
beforeAll(async () => { db = await createTestDatabase(); m = await mailTestModule(db); });
afterAll(async () => { await m.close(); });

const ok: SendResult = { kind: 'ACCEPTED', smtpCode: 250, response: '250 OK', errorCode: null };
const temp: SendResult = { kind: 'TEMP_FAIL', smtpCode: 451, response: '451 later', errorCode: null };
const amb: SendResult = { kind: 'AMBIGUOUS', smtpCode: null, response: null, errorCode: 'ECONNRESET' };
const makeDue = (id: string) => forceEmail(db, id, `next_attempt_at = clock_timestamp() - interval '1 second'`);
async function reserveOne(): Promise<ReservedEmail> {
  const r = await m.delivery.reserve(SYSTEM, 1, 120);
  expect(r).toHaveLength(1);
  return r[0]!;
}
/** Vide la file de tout ce qui est dû, pour que chaque test parte d'une file contrôlée. */
async function drainQueue() {
  for (;;) {
    const r = await m.delivery.reserve(SYSTEM, 50, 120);
    if (r.length === 0) return;
    for (const x of r) await m.delivery.finalize(SYSTEM, x, ok);
  }
}

describe('enqueueInTx', () => {
  it('chiffre le secret, ne met rien de secret dans payload, et refuse un doublon', async () => {
    const u = await seedChallengeEmail(db); // fournit un administrateur
    const id = await m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, { kind: 'anonymous', ip: '203.0.113.1' }, {
      kind: 'PASSWORD_RESET', recipientUserId: u.userId, toAddress: u.email, dedupeKey: `pr:${randomUUID()}`, payload: {}, secret: { token: 'T'.repeat(43) }, expiresInSeconds: 1800 }));
    expect(id).toBeTruthy();
    const c = await connectAs('cp_app', db);
    const r = await c.query('select payload, payload_encrypted from app.email_outbox where id = $1', [id]);
    await c.end();
    expect(JSON.stringify(r.rows[0].payload)).not.toContain('TTTT');
    expect(r.rows[0].payload_encrypted.toString('latin1')).not.toContain('TTTT');
    expect(cipher.decrypt(id!, r.rows[0].payload_encrypted)).toEqual({ token: 'T'.repeat(43) });
    const input = { kind: 'TEST' as const, recipientUserId: u.userId, toAddress: u.email, dedupeKey: `dup:${randomUUID()}`, payload: {}, expiresInSeconds: 60 };
    expect(await m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, SYSTEM, input))).toBeTruthy();
    expect(await m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, SYSTEM, input))).toBeNull();
  });
  it('refuse un contenu hors schéma et un secret manquant', async () => {
    const base = { recipientUserId: uuidv7(), toAddress: 'a@example.com', dedupeKey: `x:${randomUUID()}`, expiresInSeconds: 60 };
    await expect(m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, SYSTEM, { ...base, kind: 'TEST', payload: { extra: 1 } }))).rejects.toThrow();
    await expect(m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, SYSTEM, { ...base, kind: 'PASSWORD_RESET', payload: {} }))).rejects.toThrow();
  });
  it('la CLI ne met pas en file (action mail.enqueue)', async () => {
    await expect(m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, { kind: 'cli', command: 'create-class' }, { kind: 'TEST', recipientUserId: uuidv7(), toAddress: 'a@example.com', dedupeKey: `c:${randomUUID()}`, payload: {}, expiresInSeconds: 60 }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('reserve : filtres', () => {
  it('ne réserve ni un email pas encore dû, ni un email expiré ; crée la tentative dans la même instruction', async () => {
    await drainQueue();
    const future = await seedPlainEmail(db);
    await forceEmail(db, future, `next_attempt_at = clock_timestamp() + interval '1 hour'`);
    const expired = await seedPlainEmail(db, { ttl: '1 second' });
    await new Promise((r) => setTimeout(r, 1200));
    const due = await seedPlainEmail(db);
    const got = await m.delivery.reserve(SYSTEM, 10, 120);
    expect(got.map((x) => x.id)).toEqual([due]);
    expect(got[0]).toMatchObject({ normalAttempts: 1, retryClaimed: false });
    expect(await attemptRows(db, due)).toMatchObject([{ attempt_no: 1, kind: 'NORMAL', outcome: null }]);
    expect((await emailRow(db, future)).status).toBe('PENDING');
    expect((await emailRow(db, expired)).status).toBe('PENDING');
  });
  it('bulk_email_paused : seuls les types de sécurité partent', async () => {
    await drainQueue();
    const owner = await connectAs('cp_owner', db);
    await owner.query('update app.ops_settings set bulk_email_paused = true');
    try {
      const bulk = await seedPlainEmail(db, { kind: 'DIGEST' });
      const security = await seedPlainEmail(db, { kind: 'SECURITY_ALERT' });
      const got = await m.delivery.reserve(SYSTEM, 10, 120);
      expect(got.map((x) => x.id)).toEqual([security]);
      expect((await emailRow(db, bulk)).status).toBe('PENDING');
    } finally {
      await owner.query('update app.ops_settings set bulk_email_paused = false');
      await owner.end();
    }
  });
});

describe('reserve : atomicité (concurrence)', () => {
  it('quatre réservations parallèles se partagent 20 emails sans en prendre un deux fois', async () => {
    await drainQueue();
    const ids = await Promise.all(Array.from({ length: 20 }, () => seedPlainEmail(db)));
    const batches = await Promise.all([1, 2, 3, 4].map(() => m.delivery.reserve(SYSTEM, 10, 120)));
    const all = batches.flat().map((x) => x.id);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(await attemptRows(db, id)).toHaveLength(1);
  });
  it('un email à sa 4ᵉ tentative normale n’est réservé qu’une fois sur 12 appels parallèles ; l’échec suivant donne FAILED', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    await forceEmail(db, id, `status = 'SENDING', claim_token = gen_random_uuid(), locked_until = clock_timestamp() + interval '1 minute', normal_attempts = 4`);
    await forceEmail(db, id, `status = 'RETRY_WAIT', claim_token = null, locked_until = null, next_attempt_at = clock_timestamp() - interval '1 second'`);
    const results = await Promise.all(Array.from({ length: 12 }, () => m.delivery.reserve(SYSTEM, 1, 120)));
    const mine = results.flat().filter((x) => x.id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.normalAttempts).toBe(5);
    expect(await m.delivery.finalize(SYSTEM, mine[0]!, temp)).toBe(true);
    expect((await emailRow(db, id)).status).toBe('FAILED');
    expect(await m.delivery.reserve(SYSTEM, 5, 120)).toEqual([]);
  });
  it('la reprise ambiguë n’est réservée qu’une fois sur 12 appels parallèles ; ensuite plus rien à réserver', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    await finalizeAmbiguousFirst(id);
    const results = await Promise.all(Array.from({ length: 12 }, () => m.delivery.reserve(SYSTEM, 1, 120)));
    const mine = results.flat().filter((x) => x.id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ retryClaimed: true, normalAttempts: 1 });
    expect(await attemptRows(db, id)).toHaveLength(2);
    // Même si on le force de nouveau en UNCERTAIN, une reprise déjà prise ne se reprend pas.
    expect(await m.delivery.sweepExpiredLeases(SYSTEM, 5)).toBe(0);
    expect(await m.delivery.reserve(SYSTEM, 5, 120)).toEqual([]);
  });
  it('une réservation ignore une ligne verrouillée par une transaction ouverte (SKIP LOCKED), sans attendre', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    await holder.query('select id from app.email_outbox where id = $1 for update', [id]);
    const t0 = Date.now();
    expect(await m.delivery.reserve(SYSTEM, 5, 120)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
    await holder.query('rollback');
    await holder.end();
    expect((await m.delivery.reserve(SYSTEM, 5, 120)).map((x) => x.id)).toEqual([id]);
  });
});

async function finalizeAmbiguousFirst(id: string): Promise<void> {
  const row = await reserveOne();
  expect(row.id).toBe(id);
  expect(await m.delivery.finalize(SYSTEM, row, amb)).toBe(true);
  await makeDue(id);
}

describe('finalize : politique du § 2.4', () => {
  it('échec temporaire : RETRY_WAIT à +1 min ; ambigu : UNCERTAIN à +15 min ; la reprise ambiguë qui échoue donne FAILED', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    let row = await reserveOne();
    expect(await m.delivery.finalize(SYSTEM, row, temp)).toBe(true);
    let e = await emailRow(db, id);
    expect(e.status).toBe('RETRY_WAIT');
    expect(e.in_seconds).toBeGreaterThan(50); expect(e.in_seconds).toBeLessThanOrEqual(60);
    await makeDue(id);
    row = await reserveOne();
    expect(row.normalAttempts).toBe(2);
    expect(await m.delivery.finalize(SYSTEM, row, amb)).toBe(true);
    e = await emailRow(db, id);
    expect(e).toMatchObject({ status: 'UNCERTAIN', scheduled: true, claimed: false });
    expect(e.in_seconds).toBeGreaterThan(890); expect(e.in_seconds).toBeLessThanOrEqual(900);
    await makeDue(id);
    row = await reserveOne();
    expect(row).toMatchObject({ normalAttempts: 2, retryClaimed: true });
    expect(await m.delivery.finalize(SYSTEM, row, temp)).toBe(true);
    expect((await emailRow(db, id)).status).toBe('FAILED');
    expect((await attemptRows(db, id)).map((a) => [a.attempt_no, a.kind, a.outcome])).toEqual([[1, 'NORMAL', 'TEMP_FAIL'], [2, 'NORMAL', 'AMBIGUOUS'], [3, 'AMBIGUOUS_RETRY', 'TEMP_FAIL']]);
  });
  it('cinq échecs temporaires : FAILED à la 5ᵉ ; ambigu au 5ᵉ essai : une reprise, 6 tentatives au plus', async () => {
    await drainQueue();
    const a = await seedPlainEmail(db);
    for (let i = 1; i <= 5; i++) { await m.delivery.finalize(SYSTEM, await reserveOne(), temp); if (i < 5) await makeDue(a); }
    expect(await emailRow(db, a)).toMatchObject({ status: 'FAILED', has_payload: false });
    expect(await attemptRows(db, a)).toHaveLength(5);

    const b = await seedPlainEmail(db);
    for (let i = 1; i <= 4; i++) { await m.delivery.finalize(SYSTEM, await reserveOne(), temp); await makeDue(b); }
    await m.delivery.finalize(SYSTEM, await reserveOne(), amb);
    expect((await emailRow(db, b)).status).toBe('UNCERTAIN');
    await makeDue(b);
    const retry = await reserveOne();
    expect(retry).toMatchObject({ normalAttempts: 5, retryClaimed: true });
    await m.delivery.finalize(SYSTEM, retry, temp);
    expect((await emailRow(db, b)).status).toBe('FAILED');
    expect(await attemptRows(db, b)).toHaveLength(6);
    expect(await m.delivery.reserve(SYSTEM, 5, 120)).toEqual([]);
  });
  it('acceptation : accepted_at posé et contenu chiffré effacé ; mauvais jeton : rien ne change', async () => {
    await drainQueue();
    const s = await seedChallengeEmail(db);
    const row = await reserveOne();
    expect(row.id).toBe(s.emailId);
    expect(row.payloadEncrypted).not.toBeNull();
    expect(await m.delivery.finalize(SYSTEM, { ...row, claimToken: randomUUID() }, ok)).toBe(false);
    expect((await emailRow(db, s.emailId)).status).toBe('SENDING');
    expect(await m.delivery.finalize(SYSTEM, row, ok)).toBe(true);
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'ACCEPTED', accepted: true, has_payload: false });
    expect((await attemptRows(db, s.emailId))[0]).toMatchObject({ outcome: 'ACCEPTED', smtp_code: 250 });
    // Une seconde finalisation du même jeton ne change rien.
    expect(await m.delivery.finalize(SYSTEM, row, temp)).toBe(false);
  });
  it('un bail expiré puis repris : l’ancien jeton ne finalise ni n’annule ; le nouveau, oui', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    const stale = await reserveOne();
    await forceEmail(db, id, `locked_until = clock_timestamp() - interval '1 second'`);
    expect(await m.delivery.sweepExpiredLeases(SYSTEM, 10)).toBe(1);
    // Après le balayage, avant toute reprise : l'ancien jeton est déjà sans effet.
    expect(await m.delivery.finalize(SYSTEM, stale, ok)).toBe(false);
    expect(await m.delivery.cancelSending(SYSTEM, stale)).toBe(false);
    await makeDue(id);
    const fresh = await reserveOne();
    expect(fresh.claimToken).not.toBe(stale.claimToken);
    expect(await m.delivery.finalize(SYSTEM, stale, ok)).toBe(false);
    expect(await m.delivery.cancelSending(SYSTEM, stale)).toBe(false);
    await m.delivery.recordLateOutcome(SYSTEM, stale, ok);
    expect(await emailRow(db, id)).toMatchObject({ status: 'SENDING', accepted: false });
    const rows = await attemptRows(db, id);
    expect(rows.map((a) => [a.attempt_no, a.kind, a.outcome, a.late_outcome])).toEqual([[1, 'NORMAL', 'AMBIGUOUS', null], [2, 'AMBIGUOUS_RETRY', null, null]]);
    expect(await m.delivery.finalize(SYSTEM, fresh, ok)).toBe(true);
    expect((await emailRow(db, id)).status).toBe('ACCEPTED');
  });
  it('aucune tentative ouverte pour le jeton : l’email ne change pas (liaison tentative/jeton)', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    const row = await reserveOne();
    // Fermeture manuelle de la tentative, comme si une autre voie l'avait close : l'email ne doit pas bouger seul.
    const c = await connectAs('cp_app', db);
    await c.query(`update app.email_attempts set outcome = 'AMBIGUOUS', finished_at = clock_timestamp() where email_id = $1 and outcome is null`, [id]);
    await c.end();
    expect(await m.delivery.finalize(SYSTEM, row, ok)).toBe(false);
    expect(await m.delivery.cancelSending(SYSTEM, row)).toBe(false);
    expect((await emailRow(db, id)).status).toBe('SENDING');
  });
});

describe('annulation pendant l’envoi, dans les deux ordres (verrou observé)', () => {
  it('ordre 1 : l’annulation est validée en dernier → la finalisation attend, ne réactive rien, le résultat tardif n’écrit que son code', async () => {
    await drainQueue();
    const s = await seedChallengeEmail(db);
    const row = await reserveOne();
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [s.challengeId]);
    const pending = m.delivery.finalize(SYSTEM, row, ok);
    await waitForLockWait(db, pid);
    await holder.query('commit');
    await holder.end();
    expect(await pending).toBe(false);
    await m.delivery.recordLateOutcome(SYSTEM, row, ok);
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'CANCELLED', has_payload: false });
    expect((await attemptRows(db, s.emailId))[0]).toMatchObject({ outcome: 'CANCELLED_IN_FLIGHT', late_outcome: 'ACCEPTED', late_smtp_code: 250 });
  });
  it('ordre 2 : la finalisation est validée en dernier → l’annulation attend puis ne change rien', async () => {
    await drainQueue();
    const s = await seedChallengeEmail(db);
    await reserveOne();
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query(`update app.email_outbox set status = 'ACCEPTED', claim_token = null, locked_until = null, payload_encrypted = null, accepted_at = clock_timestamp() where id = $1`, [s.emailId]);
    await holder.query(`update app.email_attempts set outcome = 'ACCEPTED', smtp_code = 250, finished_at = clock_timestamp() where email_id = $1 and outcome is null`, [s.emailId]);
    const other = await connectAs('cp_app', db);
    const consuming = other.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [s.challengeId]);
    await waitForLockWait(db, pid);
    await holder.query('commit');
    await consuming;
    await holder.end();
    await other.end();
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'ACCEPTED', accepted: true });
    expect((await attemptRows(db, s.emailId))[0]).toMatchObject({ outcome: 'ACCEPTED' });
  });
  it('challengeStillActive et cancelSending (contrôle juste avant l’envoi)', async () => {
    await drainQueue();
    const s = await seedChallengeEmail(db);
    const row = await reserveOne();
    expect(await m.delivery.challengeStillActive(SYSTEM, row.id)).toBe(true);
    // expires_at n'est pas modifiable par cp_app : préparation de donnée sous cp_owner.
    const o = await connectAs('cp_owner', db);
    await o.query(`update app.auth_challenges set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [s.challengeId]);
    await o.end();
    expect(await m.delivery.challengeStillActive(SYSTEM, row.id)).toBe(false);
    expect(await m.delivery.cancelSending(SYSTEM, row)).toBe(true);
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'CANCELLED', has_payload: false });
    expect((await attemptRows(db, s.emailId))[0]!.outcome).toBe('CANCELLED_IN_FLIGHT');
  });
});

describe('bail expiré et expiration', () => {
  it('bail expiré : tentative AMBIGUOUS/LEASE_EXPIRED puis règle ambiguë ; reprise déjà faite : FAILED', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    await reserveOne();
    await forceEmail(db, id, `locked_until = clock_timestamp() - interval '1 second'`);
    expect(await m.delivery.sweepExpiredLeases(SYSTEM, 10)).toBe(1);
    expect(await emailRow(db, id)).toMatchObject({ status: 'UNCERTAIN', scheduled: true, claimed: false });
    expect((await attemptRows(db, id))[0]).toMatchObject({ outcome: 'AMBIGUOUS', error_code: 'LEASE_EXPIRED' });
    await makeDue(id);
    await reserveOne();
    await forceEmail(db, id, `locked_until = clock_timestamp() - interval '1 second'`);
    expect(await m.delivery.sweepExpiredLeases(SYSTEM, 10)).toBe(1);
    expect(await emailRow(db, id)).toMatchObject({ status: 'FAILED', has_payload: false });
  });
  it('le balayage ignore, sans attendre, une ligne en cours de finalisation ; la finalisation valide gagne ensuite', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    const row = await reserveOne();
    await forceEmail(db, id, `locked_until = clock_timestamp() - interval '1 second'`);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    await holder.query('select id from app.email_outbox where id = $1 for update', [id]);
    expect(await m.delivery.sweepExpiredLeases(SYSTEM, 10)).toBe(0);
    await holder.query('rollback');
    await holder.end();
    expect(await m.delivery.finalize(SYSTEM, row, ok)).toBe(true);
    expect((await emailRow(db, id)).status).toBe('ACCEPTED');
  });
  it('expireOverdue : EXPIRED et contenu effacé', async () => {
    await drainQueue();
    const s = await seedChallengeEmail(db);
    const o = await connectAs('cp_owner', db); // expires_at n'est pas modifiable par cp_app
    await o.query(`update app.email_outbox set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [s.emailId]);
    await o.end();
    expect(await m.delivery.expireOverdue(SYSTEM, 10)).toBeGreaterThanOrEqual(1);
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'EXPIRED', has_payload: false });
  });
});

describe('actions', () => {
  it('seul l’acteur système réserve', async () => {
    await expect(m.delivery.reserve({ kind: 'anonymous', ip: '203.0.113.1' } as never, 1, 120)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
