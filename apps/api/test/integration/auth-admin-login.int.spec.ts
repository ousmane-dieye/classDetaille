import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, registerStudent, send, sessionCookieOf, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { ageChallenges, createAdmin, latestCode } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
beforeAll(async () => { db = await createTestDatabase(); t = await buildTestApp(db); });
afterAll(async () => { await t.close(); });

const CHALLENGE_RE = /^__Host-cp_challenge=([A-Za-z0-9_-]{43}); Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=600$/;
const cookies = (res: { headers: Record<string, unknown> }) => [res.headers['set-cookie']].flat().filter((c): c is string => typeof c === 'string');
const challengeCookie = (res: { headers: Record<string, unknown> }) => cookies(res).find((c) => c.startsWith('__Host-cp_challenge='));
const challengeHeader = (res: { headers: Record<string, unknown> }) => ({ cookie: `__Host-cp_challenge=${CHALLENGE_RE.exec(challengeCookie(res)!)![1]}` });
async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
async function startLogin(a: { email: string; password: string }, ip?: string) {
  const res = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password }, {}, ip);
  expect(res.statusCode).toBe(202);
  return { res, header: challengeHeader(res) };
}

describe('POST /api/auth/login (administrateur)', () => {
  it('202 avec le cookie de vérification, aucune session, une vérification et un email en file', async () => {
    const a = await createAdmin(db);
    const { res } = await startLogin(a);
    expect(res.json()).toEqual({ status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: 600, resendAfterSeconds: 60 });
    expect(challengeCookie(res)).toMatch(CHALLENGE_RE);
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose = 'LOGIN' and consumed_at is null`, [a.id])).toHaveLength(1);
    const [mail] = await rows(`select kind, status, expires_at <= clock_timestamp() + interval '10 minutes' as within from app.email_outbox where recipient_user_id = $1`, [a.id]);
    expect(mail).toEqual({ kind: 'ADMIN_OTP', status: 'PENDING', within: true }); // worker arrêté : l'email attend, aucun accès (Review Focus 4)
  });
  it('mauvais mot de passe : même réponse que pour un étudiant, aucune vérification créée', async () => {
    const a = await createAdmin(db);
    const res = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: 'un mauvais mot de passe long' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('compte suspendu : ACCOUNT_SUSPENDED après un mot de passe correct ; compte bloqué : SECOND_FACTOR_BLOCKED, sans email', async () => {
    const s = await createAdmin(db, { status: 'SUSPENDED' });
    expect((await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: s.password })).json().error.code).toBe('ACCOUNT_SUSPENDED');
    const b = await createAdmin(db);
    const c = await connectAs('cp_app', db);
    await c.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [b.id]);
    await c.end();
    const res = await send(t.app, 'POST', '/api/auth/login', { email: b.email, password: b.password });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'SECOND_FACTOR_BLOCKED']);
    expect(await rows(`select 1 from app.email_outbox where recipient_user_id = $1`, [b.id])).toHaveLength(0);
  });
  it('un étudiant se connecte comme avant (régression lot 1a) : session de 30 jours, pas de vérification', async () => {
    const classId = await insertClass(db, 'L3 Admin Login');
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: s.password });
    expect(res.statusCode).toBe(200);
    expect(cookies(res).find((c) => c.startsWith('__Host-cp_session='))).toContain('Max-Age=2592000');
    expect(challengeCookie(res)).toBeUndefined();
  });
});

describe('POST /api/auth/verify-code', () => {
  it('ouvre la session (8 h, 30 min d’inactivité), efface le cookie de vérification aux mêmes attributs, journalise, annule l’email', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const res = await send(t.app, 'POST', '/api/auth/verify-code', { code: `${code.slice(0, 3)} ${code.slice(3)}` }, header); // « 123 456 » collé
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: a.id, globalRole: 'ADMIN' });
    const set = cookies(res);
    expect(set.find((c) => c.startsWith('__Host-cp_session='))).toMatch(/Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800$/);
    expect(set).toContain('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    const [s] = await rows(`select second_factor_method as m, extract(epoch from idle_expires_at - created_at)::int as idle, extract(epoch from absolute_expires_at - created_at)::int as abs from app.sessions where user_id = $1`, [a.id]);
    expect(s.m).toBe('EMAIL_CODE');
    expect(s.idle).toBeGreaterThanOrEqual(1799); expect(s.idle).toBeLessThanOrEqual(1801);
    expect(s.abs).toBeGreaterThanOrEqual(28799); expect(s.abs).toBeLessThanOrEqual(28801);
    expect((await rows(`select consumed_reason from app.auth_challenges where user_id = $1 and purpose = 'LOGIN'`, [a.id]))[0].consumed_reason).toBe('USED');
    expect((await rows(`select status, payload_encrypted is null as cleared from app.email_outbox where recipient_user_id = $1`, [a.id]))[0]).toEqual({ status: 'CANCELLED', cleared: true });
    expect((await rows(`select metadata from app.audit_log where actor_user_id is null and target_id = $1 and action = 'ADMIN_LOGIN'`, [a.id]))[0].metadata).toEqual({ method: 'EMAIL_CODE' });
    const me = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(sessionCookieOf(res)!));
    expect(me.statusCode).toBe(200);
    // le code est à usage unique
    const again = await send(t.app, 'POST', '/api/auth/verify-code', { code }, header);
    expect([again.statusCode, again.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
  });
  it('code de forme invalide : 400 VALIDATION_FAILED, aucun essai consommé (Review Focus 1)', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    for (const code of ['12345', '1234567', 'abcdef', '']) {
      const res = await send(t.app, 'POST', '/api/auth/verify-code', { code }, header);
      expect([res.statusCode, res.json().error.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect((await rows(`select attempts from app.auth_challenges where user_id = $1`, [a.id]))[0].attempts).toBe(0);
  });
  it('mauvais code : CODE_INVALID avec les essais restants, cookie conservé ; au 5ᵉ : CODE_LOCKED et cookie effacé', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const bad = code === '000000' ? '000001' : '000000';
    for (let i = 1; i <= 4; i++) {
      const res = await send(t.app, 'POST', '/api/auth/verify-code', { code: bad }, header);
      expect([res.statusCode, res.json().error.code, res.json().error.attemptsLeft]).toEqual([400, 'CODE_INVALID', 5 - i]);
      expect(cookies(res).filter((c) => c.startsWith('__Host-cp_challenge='))).toHaveLength(0);
    }
    const last = await send(t.app, 'POST', '/api/auth/verify-code', { code: bad }, header);
    expect([last.statusCode, last.json().error.code]).toEqual([400, 'CODE_LOCKED']);
    expect(cookies(last)).toContain('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    const after = await send(t.app, 'POST', '/api/auth/verify-code', { code }, header);
    expect(after.json().error.code).toBe('CHALLENGE_EXPIRED');
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it.each([
    ['sans cookie', () => ({})],
    ['cookie mal formé', () => ({ cookie: '__Host-cp_challenge=pas-un-jeton' })],
    ['cookie inconnu', () => ({ cookie: `__Host-cp_challenge=${'A'.repeat(43)}` })],
  ])('%s : 400 CHALLENGE_EXPIRED, cookie effacé, jamais 500 (Review Focus 3)', async (_n, headers) => {
    const res = await send(t.app, 'POST', '/api/auth/verify-code', { code: '123456' }, headers());
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect(cookies(res)).toContain('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
  });
  it('vérification expirée (donnée modifiée) : CHALLENGE_EXPIRED', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const o = await connectAs('cp_owner', db);
    await o.query(`update app.auth_challenges set expires_at = clock_timestamp() - interval '1 second' where user_id = $1`, [a.id]);
    await o.end();
    expect((await send(t.app, 'POST', '/api/auth/verify-code', { code }, header)).json().error.code).toBe('CHALLENGE_EXPIRED');
  });
  it('le cookie d’un administrateur ne sert pas le code d’un autre', async () => {
    const a = await createAdmin(db);
    const b = await createAdmin(db);
    const { header: headerA } = await startLogin(a);
    await startLogin(b);
    const codeB = await latestCode(db, b.email);
    const res = await send(t.app, 'POST', '/api/auth/verify-code', { code: codeB }, headerA);
    expect(res.json().error.code).toBe('CODE_INVALID');
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [b.id])).toHaveLength(0);
  });
  it('limite des essais par préfixe d’IP : 30 par heure puis 429', async () => {
    const ip = '198.51.100.77';
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await send(t.app, 'POST', '/api/auth/verify-code', { code: '123456' }, {}, ip)).statusCode;
    expect(last).toBe(429);
  });
});

describe('compte modifié entre le mot de passe et le code', () => {
  it.each([
    ['suspendu', `update app.users set status = 'SUSPENDED' where id = $1`],
    ['rétrogradé en USER', `update app.users set global_role = 'USER' where id = $1`],
  ])('%s : CHALLENGE_EXPIRED, aucune session, aucun ADMIN_LOGIN', async (_n, sql) => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const o = await connectAs('cp_owner', db);
    await o.query(sql, [a.id]);
    await o.end();
    const res = await send(t.app, 'POST', '/api/auth/verify-code', { code }, header);
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
    expect(await rows(`select 1 from app.audit_log where target_id = $1 and action = 'ADMIN_LOGIN'`, [a.id])).toHaveLength(0);
  });
});

describe('deux validations simultanées de la même vérification (verrou observé)', () => {
  async function holdThenVerify(outcome: 'COMMIT' | 'ROLLBACK') {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [a.id]);
    await holder.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where user_id = $1 and purpose = 'LOGIN'`, [a.id]);
    const pending = send(t.app, 'POST', '/api/auth/verify-code', { code }, header);
    await waitForLockWait(db, pid);
    await holder.query(outcome);
    await holder.end();
    return { res: await pending, a };
  }
  it('le titulaire a consommé la vérification : CHALLENGE_EXPIRED, aucune session', async () => {
    const { res, a } = await holdThenVerify('COMMIT');
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('le titulaire a annulé : la validation réussit', async () => {
    const { res } = await holdThenVerify('ROLLBACK');
    expect(res.statusCode).toBe(200);
  });
  it('deux requêtes parallèles avec le bon code : une session, une erreur', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const res = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/auth/verify-code', { code }, header)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(1);
  });
});

describe('POST /api/auth/resend-code', () => {
  it('renvoi immédiat : 429 TOO_MANY_CODE_REQUESTS avec Retry-After ; l’ancien code reste valable', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const res = await send(t.app, 'POST', '/api/auth/resend-code', {}, header);
    expect([res.statusCode, res.json().error.code]).toEqual([429, 'TOO_MANY_CODE_REQUESTS']);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const code = await latestCode(db, a.email);
    expect((await send(t.app, 'POST', '/api/auth/verify-code', { code }, header)).statusCode).toBe(200);
  });
  it('après 1 minute : nouveau code et nouveau cookie ; l’ancien cookie et l’ancien code ne servent plus, son email est annulé', async () => {
    const a = await createAdmin(db);
    const { header: oldHeader } = await startLogin(a);
    const oldCode = await latestCode(db, a.email);
    await ageChallenges(db, a.id, 2);
    const res = await send(t.app, 'POST', '/api/auth/resend-code', {}, oldHeader);
    expect(res.statusCode).toBe(202);
    expect(challengeCookie(res)).toMatch(CHALLENGE_RE);
    const newCode = await latestCode(db, a.email);
    expect(newCode).not.toBe(oldCode);
    expect((await send(t.app, 'POST', '/api/auth/verify-code', { code: oldCode }, oldHeader)).json().error.code).toBe('CHALLENGE_EXPIRED');
    expect((await rows(`select count(*)::int as n from app.email_outbox where recipient_user_id = $1 and status = 'CANCELLED'`, [a.id]))[0].n).toBe(1);
    expect((await send(t.app, 'POST', '/api/auth/verify-code', { code: newCode }, challengeHeader(res))).statusCode).toBe(200);
  });
  it('double clic : deux renvois simultanés, un seul aboutit, une seule vérification active (Review Focus 2)', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    await ageChallenges(db, a.id, 2);
    const res = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/auth/resend-code', {}, header)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([202, 429]);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose = 'LOGIN' and consumed_at is null`, [a.id])).toHaveLength(1);
    expect(await rows(`select 1 from app.email_outbox where recipient_user_id = $1 and status = 'PENDING'`, [a.id])).toHaveLength(1);
  });
  it('sans cookie : 400 CHALLENGE_EXPIRED', async () => {
    const res = await send(t.app, 'POST', '/api/auth/resend-code', {});
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
  });
});

describe('session d’administrateur', () => {
  it('30 minutes d’inactivité : une session dont l’échéance est dépassée donne 401 et efface le cookie', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const login = await send(t.app, 'POST', '/api/auth/verify-code', { code: await latestCode(db, a.email) }, header);
    const token = sessionCookieOf(login)!;
    const c = await connectAs('cp_app', db);
    await c.query(`update app.sessions set idle_expires_at = clock_timestamp() - interval '1 second' where user_id = $1`, [a.id]);
    await c.end();
    const me = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(token));
    expect(me.statusCode).toBe(401);
    expect(cookies(me)).toContain('__Host-cp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  });
  it('l’activité prolonge l’inactivité d’une session d’administrateur de 30 minutes, plafonnée à 8 h', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const login = await send(t.app, 'POST', '/api/auth/verify-code', { code: await latestCode(db, a.email) }, header);
    const c = await connectAs('cp_app', db);
    await c.query(`update app.sessions set last_seen_at = clock_timestamp() - interval '10 minutes' where user_id = $1`, [a.id]);
    await send(t.app, 'GET', '/api/me', undefined, cookieHeader(sessionCookieOf(login)!));
    const r = await c.query(`select extract(epoch from idle_expires_at - clock_timestamp())::int as left from app.sessions where user_id = $1`, [a.id]);
    await c.end();
    expect(r.rows[0].left).toBeGreaterThan(1790); expect(r.rows[0].left).toBeLessThanOrEqual(1800);
  });
});
