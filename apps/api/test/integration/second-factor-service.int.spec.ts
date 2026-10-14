import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ApiError } from '../../src/http/errors.js';
import { ChallengesRepository } from '../../src/modules/auth/second-factor/challenges.repository.js';
import { BUCKET_ROW_CAP } from '../../src/modules/auth/login-rate-limiter.js';
import { OtpLimiter } from '../../src/modules/auth/second-factor/otp-limiter.js';
import { otpHmac } from '../../src/modules/auth/second-factor/otp.js';
import { SecondFactorService, outcomeToError, type CheckOutcome } from '../../src/modules/auth/second-factor/second-factor.service.js';
import { buildTestApp, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { ageChallenges, createAdmin, createAdminSession, latestCode, seedHistory } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let sf: SecondFactorService;
let prisma: PrismaService;
const anon = { kind: 'anonymous', ip: '203.0.113.7' } as const;
beforeAll(async () => {
  db = await createTestDatabase();
  t = await buildTestApp(db);
  sf = t.app.get(SecondFactorService, { strict: false });
  prisma = t.app.get(PrismaService, { strict: false });
});
afterAll(async () => { await t.close(); });

const issueLogin = (userId: string) => prisma.withTx((tx) => sf.issueInTx(tx, anon, { userId, purpose: 'LOGIN', sessionId: null, pendingEmail: null, tokenHash: randomBytes(32), ip: anon.ip }));
const check = (userId: string, code: string, challengeId?: string) =>
  prisma.withTx((tx) => sf.checkInTx(tx, anon, { userId, purpose: 'LOGIN', code, ...(challengeId ? { challengeId } : {}) }));
async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const active = (userId: string) => rows(`select id, attempts from app.auth_challenges where user_id = $1 and consumed_at is null and purpose = 'LOGIN'`, [userId]);
const wrong = (code: string) => (code === '000000' ? '000001' : '000000');
async function seedFailures(userId: string, n: number) {
  const c = await connectAs('cp_app', db);
  try {
    for (let i = 0; i < n; i++) await c.query(`insert into app.second_factor_failures (user_id, challenge_id, purpose) values ($1,$2,'STEP_UP')`, [userId, uuidv7()]);
  } finally { await c.end(); }
}

describe('issueInTx', () => {
  it('crée une vérification active, un HMAC conforme et un email chiffré lié', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    expect(issued).toMatchObject({ expiresInSeconds: 600, resendAfterSeconds: 60 });
    const code = await latestCode(db, a.email);
    expect(code).toMatch(/^[0-9]{6}$/);
    const [ch] = await rows(`select id, code_hmac, expires_at > clock_timestamp() + interval '9 minutes' as ten from app.auth_challenges where id = $1`, [issued.challengeId]);
    expect(ch.code_hmac.equals(otpHmac(t.config().security.otpPepper, issued.challengeId, code))).toBe(true);
    expect(ch.ten).toBe(true);
    const [mail] = await rows(`select kind, status, challenge_id, payload from app.email_outbox where challenge_id = $1`, [issued.challengeId]);
    expect(mail).toMatchObject({ kind: 'ADMIN_OTP', status: 'PENDING', challenge_id: issued.challengeId, payload: { purpose: 'LOGIN' } });
    expect(JSON.stringify(mail.payload)).not.toContain(code);
  });
  it('consomme l’ancienne (SUPERSEDED) et annule son email ; une seule vérification reste active', async () => {
    const a = await createAdmin(db);
    const first = await issueLogin(a.id);
    await ageChallenges(db, a.id, 2);
    const second = await issueLogin(a.id);
    expect((await active(a.id)).map((r) => r.id)).toEqual([second.challengeId]);
    const [old] = await rows(`select consumed_reason from app.auth_challenges where id = $1`, [first.challengeId]);
    expect(old.consumed_reason).toBe('SUPERSEDED');
    const [oldMail] = await rows(`select status, payload_encrypted is null as cleared from app.email_outbox where challenge_id = $1`, [first.challengeId]);
    expect(oldMail).toEqual({ status: 'CANCELLED', cleared: true });
  });
  it('limites : 1 par minute, 5 par heure, 10 par jour', async () => {
    const a = await createAdmin(db);
    await issueLogin(a.id);
    await expect(issueLogin(a.id)).rejects.toMatchObject({ code: 'TOO_MANY_CODE_REQUESTS', headers: { 'retry-after': expect.stringMatching(/^[0-9]+$/) } });
    const b = await createAdmin(db);
    await seedHistory(db, b.id, 5, 30); // 5 demandes dans l'heure, aucune dans la dernière minute
    await expect(issueLogin(b.id)).rejects.toMatchObject({ code: 'TOO_MANY_CODE_REQUESTS' });
    const c = await createAdmin(db);
    await seedHistory(db, c.id, 4, 30);
    await issueLogin(c.id); // la 5ᵉ de l'heure passe
    const d = await createAdmin(db);
    await seedHistory(db, d.id, 10, 120); // 10 dans la journée, aucune dans l'heure
    await expect(issueLogin(d.id)).rejects.toMatchObject({ code: 'TOO_MANY_CODE_REQUESTS' });
  });
  it('un administrateur bloqué : 403 SECOND_FACTOR_BLOCKED, aucune vérification, aucun email', async () => {
    const a = await createAdmin(db);
    const c = await connectAs('cp_app', db);
    await c.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [a.id]);
    await c.end();
    await expect(issueLogin(a.id)).rejects.toMatchObject({ code: 'SECOND_FACTOR_BLOCKED' });
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1`, [a.id])).toHaveLength(0);
    expect(await rows(`select 1 from app.email_outbox where recipient_user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('un étudiant, un compte suspendu ou inconnu : CHALLENGE_EXPIRED, jamais de vérification', async () => {
    const s = await createAdmin(db, { status: 'SUSPENDED' });
    await expect(issueLogin(s.id)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
    await expect(issueLogin(uuidv7())).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
  });
  it('un acteur non autorisé est refusé', async () => {
    const a = await createAdmin(db);
    await expect(prisma.withTx((tx) => sf.issueInTx(tx, { kind: 'cli', command: 'create-class' } as never, { userId: a.id, purpose: 'LOGIN', sessionId: null, pendingEmail: null, tokenHash: Buffer.alloc(32, 1), ip: null }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('issueInTx : atomicité des limites', () => {
  it('six demandes simultanées : une seule aboutit (1 par minute), une vérification active, un email', async () => {
    const a = await createAdmin(db);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => issueLogin(a.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as ApiError).code).toBe('TOO_MANY_CODE_REQUESTS');
    expect(await active(a.id)).toHaveLength(1);
    expect(await rows(`select 1 from app.email_outbox where recipient_user_id = $1 and status <> 'CANCELLED'`, [a.id])).toHaveLength(1);
  });
  it('une demande qui attend le verrou de l’administrateur est servie après lui (verrou observé)', async () => {
    const a = await createAdmin(db);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [a.id]);
    const pending = issueLogin(a.id);
    await waitForLockWait(db, pid);
    await holder.query('rollback');
    await holder.end();
    expect((await pending).expiresInSeconds).toBe(600);
  });
});

describe('checkInTx', () => {
  async function fresh() {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    return { a, issued, code: await latestCode(db, a.email) };
  }
  it('bon code : ok, la vérification n’est consommée que par l’appelant', async () => {
    const { a, issued, code } = await fresh();
    const r = await check(a.id, code, issued.challengeId);
    expect(r).toMatchObject({ ok: true, challenge: { id: issued.challengeId, purpose: 'LOGIN' } });
    expect(await active(a.id)).toHaveLength(1);
  });
  it('mauvais code : l’échec est enregistré (validé), 5 essais puis LOCKED, l’email est annulé', async () => {
    const { a, issued, code } = await fresh();
    for (let i = 1; i <= 4; i++) expect(await check(a.id, wrong(code), issued.challengeId)).toEqual({ ok: false, reason: 'WRONG', attemptsLeft: 5 - i });
    expect((await active(a.id))[0]!.attempts).toBe(4);
    expect(await check(a.id, wrong(code), issued.challengeId)).toEqual({ ok: false, reason: 'LOCKED' });
    expect(await active(a.id)).toHaveLength(0);
    expect(await rows(`select 1 from app.second_factor_failures where user_id = $1`, [a.id])).toHaveLength(5);
    const [mail] = await rows(`select status from app.email_outbox where challenge_id = $1`, [issued.challengeId]);
    expect(mail.status).toBe('CANCELLED');
    expect(await check(a.id, code, issued.challengeId)).toEqual({ ok: false, reason: 'EXPIRED' });
  });
  it('3ᵉ échec : alerte à tous les administrateurs actifs, sans doublon dans l’heure (R7)', async () => {
    const a = await createAdmin(db);
    const other = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const c = await connectAs('cp_app', db);
    for (let i = 0; i < 2; i++) await c.query(`insert into app.second_factor_failures (user_id, challenge_id, purpose) values ($1,$2,'LOGIN')`, [a.id, issued.challengeId]);
    await c.end();
    await check(a.id, wrong(code), issued.challengeId); // 3ᵉ
    await check(a.id, wrong(code), issued.challengeId); // 4ᵉ : même heure, pas de doublon
    const alerts = await rows(`select recipient_user_id, dedupe_key, payload from app.email_outbox where kind = 'ADMIN_SECURITY_ALERT' and payload->>'accountEmail' = $1`, [a.email]);
    const recipients = alerts.map((r) => r.recipient_user_id);
    expect(recipients).toContain(a.id);
    expect(recipients).toContain(other.id);
    expect(new Set(recipients).size).toBe(recipients.length);
    expect(alerts[0].dedupe_key).toMatch(new RegExp(`^admin-2fa-alert:${a.id}:[0-9]{10}:`));
    expect(alerts[0].payload).toMatchObject({ event: 'SECOND_FACTOR_FAILURES', failures: 3 });
  });
  it('10ᵉ échec en 60 minutes : compte bloqué, vérifications consommées, audit, alerte ; puis refus sans comparaison', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    await seedFailures(a.id, 9);
    expect(await check(a.id, wrong(code), issued.challengeId)).toEqual({ ok: false, reason: 'BLOCKED' });
    const [u] = await rows(`select second_factor_blocked_at is not null as blocked from app.users where id = $1`, [a.id]);
    expect(u.blocked).toBe(true);
    expect(await active(a.id)).toHaveLength(0);
    const [audit] = await rows(`select source, action, metadata from app.audit_log where target_id = $1 and action = 'ADMIN_SECOND_FACTOR_BLOCKED'`, [a.id]);
    expect(audit).toMatchObject({ source: 'APP', metadata: { failures: 10 } });
    expect((await rows(`select 1 from app.email_outbox where kind = 'ADMIN_SECURITY_ALERT' and payload->>'event' = 'SECOND_FACTOR_BLOCKED' and payload->>'accountEmail' = $1`, [a.email])).length).toBeGreaterThanOrEqual(1);
  });
  it('le blocage est persistant : il reste posé quand les échecs sortent de la fenêtre de 60 minutes (R3)', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    await seedFailures(a.id, 9);
    await check(a.id, wrong(code), issued.challengeId);
    const p = await connectAs('postgres', db);
    try {
      await p.query('set session_replication_role = replica');
      await p.query(`update app.second_factor_failures set occurred_at = occurred_at - interval '3 hours' where user_id = $1`, [a.id]);
    } finally { await p.end(); }
    await expect(issueLogin(a.id)).rejects.toMatchObject({ code: 'SECOND_FACTOR_BLOCKED' });
  });
  it('compte bloqué : le bon code est refusé sans comparaison (aucun essai ni échec enregistré)', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const c = await connectAs('cp_app', db);
    await c.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [a.id]);
    await c.end();
    expect(await check(a.id, code, issued.challengeId)).toEqual({ ok: false, reason: 'BLOCKED' });
    expect((await active(a.id))[0]!.attempts).toBe(0);
    expect(await rows(`select 1 from app.second_factor_failures where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('outcomeToError : codes et en-têtes', () => {
    const wrongE = outcomeToError({ ok: false, reason: 'WRONG', attemptsLeft: 3 } as Exclude<CheckOutcome, { ok: true }>, { clearChallengeCookie: true });
    expect([wrongE.getStatus(), wrongE.code, wrongE.extra]).toEqual([400, 'CODE_INVALID', { attemptsLeft: 3 }]);
    const locked = outcomeToError({ ok: false, reason: 'LOCKED' }, { clearChallengeCookie: true });
    expect([locked.getStatus(), locked.code, locked.headers['set-cookie']]).toEqual([400, 'CODE_LOCKED', '__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0']);
    expect(outcomeToError({ ok: false, reason: 'EXPIRED' }, { clearChallengeCookie: false }).headers).toEqual({});
    expect(outcomeToError({ ok: false, reason: 'BLOCKED' }, { clearChallengeCookie: false })).toMatchObject({ code: 'SECOND_FACTOR_BLOCKED' });
    expect(outcomeToError({ ok: false, reason: 'BLOCKED' }, { clearChallengeCookie: false }).getStatus()).toBe(403);
  });
});

describe('checkInTx : codes faux simultanés (le décompte ne dépasse jamais les seuils)', () => {
  it('12 mauvais codes en parallèle sur une vérification : 4 WRONG, 1 LOCKED, 7 EXPIRED ; 5 essais et 5 échecs exactement', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const results = await Promise.all(Array.from({ length: 12 }, () => check(a.id, wrong(code), issued.challengeId)));
    const count = (reason: string) => results.filter((r) => !r.ok && r.reason === reason).length;
    expect([count('WRONG'), count('LOCKED'), count('EXPIRED')]).toEqual([4, 1, 7]);
    expect(await rows(`select 1 from app.second_factor_failures where user_id = $1`, [a.id])).toHaveLength(5);
    const [ch] = await rows(`select attempts, consumed_reason from app.auth_challenges where id = $1`, [issued.challengeId]);
    expect(ch).toEqual({ attempts: 5, consumed_reason: 'LOCKED' });
  });
  it('seuil de blocage sous concurrence : exactement 10 échecs, un seul blocage, un seul audit', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    await seedFailures(a.id, 6);
    const results = await Promise.all(Array.from({ length: 12 }, () => check(a.id, wrong(code), issued.challengeId)));
    expect(results.filter((r) => !r.ok && r.reason === 'BLOCKED').length).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => !r.ok && r.reason === 'WRONG')).toHaveLength(3);
    expect(await rows(`select 1 from app.second_factor_failures where user_id = $1`, [a.id])).toHaveLength(10);
    expect(await rows(`select 1 from app.audit_log where target_id = $1 and action = 'ADMIN_SECOND_FACTOR_BLOCKED'`, [a.id])).toHaveLength(1);
  });
  it('bons et mauvais codes mêlés : le bon code ne réussit qu’avant le verrouillage, jamais après', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const attempt = (c: string) => prisma.withTx(async (tx) => {
      const r = await sf.checkInTx(tx, anon, { userId: a.id, purpose: 'LOGIN', code: c, challengeId: issued.challengeId });
      if (r.ok) await sf.consumeInTx(tx, anon, r.challenge, 'USED');
      return r;
    });
    const results = await Promise.all([...Array.from({ length: 8 }, () => attempt(wrong(code))), attempt(code), attempt(code)]);
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    expect(await rows(`select 1 from app.second_factor_failures where user_id = $1`, [a.id]).then((r) => r.length)).toBeLessThanOrEqual(5);
  });
});

describe('checkInTx : deux validations simultanées (verrou observé, deux issues)', () => {
  /** Le titulaire tient le verrou de l'administrateur ; la vérification attend ; puis il valide ou annule. */
  async function holdThenCheck(outcome: 'COMMIT' | 'ROLLBACK') {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [a.id]);
    await holder.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [issued.challengeId]);
    const pending = check(a.id, code, issued.challengeId);
    await waitForLockWait(db, pid);
    await holder.query(outcome);
    await holder.end();
    return pending;
  }
  it('le titulaire a consommé la vérification : la seconde validation reçoit EXPIRED', async () => {
    expect(await holdThenCheck('COMMIT')).toEqual({ ok: false, reason: 'EXPIRED' });
  });
  it('le titulaire a annulé : la seconde validation réussit', async () => {
    expect(await holdThenCheck('ROLLBACK')).toMatchObject({ ok: true });
  });
  it('deux validations parallèles du même code : une seule réussit à consommer', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const attempt = () => prisma.withTx(async (tx) => {
      const r = await sf.checkInTx(tx, anon, { userId: a.id, purpose: 'LOGIN', code, challengeId: issued.challengeId });
      if (r.ok) await sf.consumeInTx(tx, anon, r.challenge, 'USED');
      return r;
    });
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'EXPIRED')).toHaveLength(1);
  });
});

describe('consumeBySessionsInTx (D2)', () => {
  it('consomme en SESSION_ENDED les vérifications non consommées des sessions visées, et elles seulement ; annule leurs emails', async () => {
    const repo = t.app.get(ChallengesRepository, { strict: false });
    const a = await createAdmin(db);
    const s1 = await createAdminSession(db, a.id);
    const s2 = await createAdminSession(db, a.id);
    const s3 = await createAdminSession(db, a.id);
    const mk = (sessionId: string, purpose: 'STEP_UP' | 'EMAIL_CHANGE_OLD') => prisma.withTx((tx) =>
      sf.issueInTx(tx, { kind: 'user', userId: a.id, globalRole: 'ADMIN', sessionId }, { userId: a.id, purpose, sessionId, pendingEmail: purpose === 'STEP_UP' ? null : 'nouvelle@example.com', tokenHash: null, ip: null }));
    const c1 = await mk(s1, 'STEP_UP');
    await ageChallenges(db, a.id, 2);
    const c2 = await mk(s2, 'EMAIL_CHANGE_OLD');
    await ageChallenges(db, a.id, 2);
    const c3 = await mk(s3, 'STEP_UP'); // remplace c1 (même usage)
    const n = await prisma.withTx((tx) => repo.consumeBySessionsInTx(tx, [s1, s2, uuidv7()]));
    expect(n).toBe(1); // c1 a été remplacée par c3 (SUPERSEDED) ; seule c2 est encore active parmi s1, s2
    const state = await rows(`select id, consumed_reason from app.auth_challenges where id = any($1::uuid[]) order by created_at`, [[c1.challengeId, c2.challengeId, c3.challengeId]]);
    expect(state.map((r) => r.consumed_reason)).toEqual(['SUPERSEDED', 'SESSION_ENDED', null]);
    const [mail] = await rows(`select status from app.email_outbox where challenge_id = $1`, [c2.challengeId]);
    expect(mail.status).toBe('CANCELLED');
    expect(await prisma.withTx((tx) => repo.consumeBySessionsInTx(tx, []))).toBe(0);
  });
});

describe('OtpLimiter', () => {
  it('10 demandes par heure et par préfixe d’IP, 30 essais', async () => {
    const lim = t.app.get(OtpLimiter, { strict: false });
    for (let i = 0; i < 10; i++) await lim.hitRequest('198.51.100.9');
    await expect(lim.hitRequest('198.51.100.9')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS', headers: { 'retry-after': expect.stringMatching(/^[0-9]+$/) } });
    await lim.hitRequest('198.51.100.10');
    for (let i = 0; i < 30; i++) await lim.hitTry('198.51.100.20');
    await expect(lim.hitTry('198.51.100.20')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });
  it('25 demandes simultanées depuis la même IP : exactement 10 passent (incrément atomique)', async () => {
    const lim = t.app.get(OtpLimiter, { strict: false });
    const r = await Promise.allSettled(Array.from({ length: 25 }, () => lim.hitRequest('198.51.100.30')));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(10);
  });
  it('plafond de lignes (D13) : au-delà, aucune ligne n’est créée pour une IP nouvelle, les IP connues restent limitées', async () => {
    const lim = t.app.get(OtpLimiter, { strict: false });
    for (let i = 0; i < 10; i++) await lim.hitRequest('198.51.100.40'); // seau existant, déjà à la limite
    const o = await connectAs('cp_owner', db);
    try {
      await o.query(`insert into app.rate_limit_buckets (key, window_start, attempts) select 'ip:' || to_hex(i + 1048576), clock_timestamp(), 1 from generate_series(1, $1::int) i`, [BUCKET_ROW_CAP + 1]);
      await lim.hitRequest('198.51.100.41'); // IP nouvelle : passe, sans créer de ligne
      expect(await rows(`select 1 from app.rate_limit_buckets where key = 'otp-ip:198.51.100.41'`)).toHaveLength(0);
      await expect(lim.hitRequest('198.51.100.40')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    } finally {
      await o.query(`delete from app.rate_limit_buckets where key ~ '^ip:[0-9a-f]+$'`);
      await o.end();
    }
    await lim.hitRequest('198.51.100.41'); // plafond levé : le seau est de nouveau créé
    expect(await rows(`select 1 from app.rate_limit_buckets where key = 'otp-ip:198.51.100.41'`)).toHaveLength(1);
  });
});
