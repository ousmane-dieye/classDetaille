import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, markDeleted, PASSWORD, query, registerStudent, send, sessionCookieOf, type TestApp } from '../support/app.js';
import { createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let classId: string;
beforeAll(async () => {
  db = await createTestDatabase();
  classId = await insertClass(db, 'L3 Informatique');
  t = await buildTestApp(db);
});
afterAll(async () => { await t.close(); });

const login = (body: Record<string, unknown>, ip?: string) => send(t.app, 'POST', '/api/auth/login', body, {}, ip);
const withoutId = (b: { error: unknown }) => b.error;
const ageFailures = () => query(db, `update app.rate_limit_buckets set last_failure_at = last_failure_at - interval '1 hour' where key like 'ip+acct:%'`);

describe('POST /api/auth/login (P2, § 3.2)', () => {
  it('succès : nouveau jeton à chaque connexion, cookie aux bons attributs', async () => {
    const s = await registerStudent(t.app, classId);
    const a = await login({ email: s.email, password: PASSWORD });
    const b = await login({ email: s.email, password: PASSWORD });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ email: s.email, enrollment: { status: 'PENDING' } });
    expect(sessionCookieOf(a)).not.toBe(sessionCookieOf(b));
    expect(sessionCookieOf(a)).not.toBe(s.token);
  });
  it('réponse identique : email inconnu, mauvais mot de passe, compte supprimé', async () => {
    const s = await registerStudent(t.app, classId);
    const deleted = await registerStudent(t.app, classId);
    await markDeleted(db, deleted.userId);
    const r1 = await login({ email: 'nobody@example.com', password: PASSWORD });
    const r2 = await login({ email: s.email, password: `${PASSWORD}!` });
    const r3 = await login({ email: deleted.email, password: PASSWORD });
    for (const r of [r1, r2, r3]) expect(r.statusCode).toBe(401);
    expect(withoutId(r1.json())).toEqual({ code: 'INVALID_CREDENTIALS', turnstileRequired: false });
    expect(withoutId(r2.json())).toEqual(withoutId(r1.json()));
    expect(withoutId(r3.json())).toEqual(withoutId(r1.json()));
    expect(r1.headers['set-cookie']).toBeUndefined();
  });
  it('suspension signalée seulement après un mot de passe correct', async () => {
    const s = await registerStudent(t.app, classId);
    await query(db, `update app.users set status = 'SUSPENDED' where id = $1`, [s.userId], 'cp_owner');
    expect((await login({ email: s.email, password: 'mauvais mot de passe long' })).json().error.code).toBe('INVALID_CREDENTIALS');
    const ok = await login({ email: s.email, password: PASSWORD });
    expect(ok.statusCode).toBe(403);
    expect(ok.json().error.code).toBe('ACCOUNT_SUSPENDED');
  });
  it('administrateur : 202 (code requis), aucun cookie de session', async () => {
    const s = await registerStudent(t.app, classId);
    // Préparation de donnée : promotion directe par le propriétaire (le parcours de promotion arrive au lot 2).
    await query(db, `update app.users set global_role = 'ADMIN' where id = $1`, [s.userId], 'cp_owner');
    const before = (await query(db, `select count(*)::int as n from app.sessions where user_id = $1`, [s.userId])).rows[0].n;
    const res = await login({ email: s.email, password: PASSWORD });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('ADMIN_CODE_REQUIRED');
    expect(sessionCookieOf(res)).toBeUndefined();
    expect((await query(db, `select count(*)::int as n from app.sessions where user_id = $1`, [s.userId])).rows[0].n).toBe(before);
  });
  it('variantes de l’email : même seau ; Turnstile demandé après 3 échecs ; 429 au-delà de 5', async () => {
    const s = await registerStudent(t.app, classId, { email: 'variant@example.com' });
    const ip = '203.0.113.40';
    for (const email of ['variant@example.com', ' VARIANT@example.com', 'ｖａｒｉａｎｔ@example.com']) {
      await login({ email, password: 'mauvais mot de passe long' }, ip);
      await ageFailures();
    }
    // check() réserve chaque tentative comme un échec : la 4e (refusée faute de Turnstile) et la 5e comptent aussi.
    const needs = await login({ email: s.email, password: PASSWORD }, ip);
    expect(needs.statusCode).toBe(401);
    expect(needs.json().error).toEqual({ code: 'TURNSTILE_REQUIRED', turnstileRequired: true });
    await ageFailures();
    t.turnstile.next = 'invalid';
    try {
      expect((await login({ email: s.email, password: PASSWORD, turnstileToken: 'bad' }, ip)).json().error.code).toBe('TURNSTILE_REQUIRED');
    } finally {
      t.turnstile.next = 'valid';
    }
    await ageFailures();
    const limited = await login({ email: s.email, password: PASSWORD, turnstileToken: 'tok' }, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Depuis une autre IP, le titulaire se connecte (un compte n'est jamais bloqué).
    expect((await login({ email: s.email, password: PASSWORD }, '203.0.113.41')).statusCode).toBe(200);
  });
  it('délai croissant : une tentative immédiatement après un échec → 429 Retry-After: 1', async () => {
    const s = await registerStudent(t.app, classId);
    const ip = '203.0.113.42';
    await login({ email: s.email, password: 'mauvais mot de passe long' }, ip);
    const r = await login({ email: s.email, password: PASSWORD }, ip);
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('1');
  });
  it('Turnstile exigé et service en erreur isolée (hors mode dégradé) → TURNSTILE_REQUIRED, pas de session', async () => {
    const local = await buildTestApp(db);
    try {
      const s = await registerStudent(local.app, classId);
      const ip = '203.0.113.44';
      for (let i = 0; i < 3; i++) {
        await send(local.app, 'POST', '/api/auth/login', { email: s.email, password: 'mauvais mot de passe long' }, {}, ip);
        await ageFailures();
      }
      local.turnstile.next = 'error';
      const r = await send(local.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD, turnstileToken: 'tok' }, {}, ip);
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('TURNSTILE_REQUIRED');
      expect(sessionCookieOf(r)).toBeUndefined();
    } finally {
      await local.close();
    }
  });
  it('mode dégradé de Turnstile : 2 échecs par couple IP + compte suffisent à limiter', async () => {
    const local = await buildTestApp(db);
    try {
      local.turnstile.next = 'error';
      // Trois erreurs du service (via l'inscription) → mode dégradé.
      for (let i = 0; i < 3; i++) await send(local.app, 'POST', '/api/auth/register', { firstName: 'Awa', lastName: 'Diop', email: `deg${i}@example.com`, password: PASSWORD, classId, turnstileToken: 'tok' });
      const s = await registerStudent(t.app, classId);
      const ip = '203.0.113.43';
      for (let i = 0; i < 2; i++) {
        await send(local.app, 'POST', '/api/auth/login', { email: s.email, password: 'mauvais mot de passe long' }, {}, ip);
        await ageFailures();
      }
      expect((await send(local.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD }, {}, ip)).statusCode).toBe(429);
    } finally {
      await local.close();
    }
  });
});

describe('POST /api/auth/logout', () => {
  it('204, cookie effacé aux mêmes attributs, jeton inutilisable ensuite', async () => {
    const s = await registerStudent(t.app, classId);
    const out = await send(t.app, 'POST', '/api/auth/logout', {}, cookieHeader(s.token));
    expect(out.statusCode).toBe(204);
    expect(out.headers['set-cookie']).toBe('__Host-cp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
    const again = await send(t.app, 'POST', '/api/auth/logout', {}, cookieHeader(s.token));
    expect(again.statusCode).toBe(401);
    expect(again.headers['set-cookie']).toBe('__Host-cp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
    expect((await query(db, `select revoke_reason from app.sessions where user_id = $1`, [s.userId])).rows).toEqual([{ revoke_reason: 'LOGOUT' }]);
  });
  it('sans cookie → 401 sans Set-Cookie', async () => {
    const res = await send(t.app, 'POST', '/api/auth/logout', {});
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
