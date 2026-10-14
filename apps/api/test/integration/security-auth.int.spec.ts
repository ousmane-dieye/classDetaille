import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, PASSWORD, query, registerStudent, send, type TestApp } from '../support/app.js';
import { createTestDatabase } from '../support/pg.js';

const CLEAR = '__Host-cp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
let db: string;
let t: TestApp;
let classId: string;
const logs: string[] = [];
beforeAll(async () => {
  db = await createTestDatabase();
  classId = await insertClass(db, 'L3 Informatique');
  const logStream = new Writable({ write(c, _e, cb) { logs.push(String(c)); cb(); } });
  t = await buildTestApp(db, { config: { http: { origin: 'https://app.test', trustProxy: 0, logLevel: 'info' } }, logStream });
});
afterAll(async () => { await t.close(); });

describe('sécurité — sessions (§ 3.4)', () => {
  it.each([
    ['révoquée', (id: string) => query(db, `update app.sessions set revoked_at = clock_timestamp(), revoke_reason = 'ADMIN_REVOKED' where user_id = $1`, [id])],
    ['inactivité dépassée', (id: string) => query(db, `update app.sessions set idle_expires_at = clock_timestamp() - interval '1 second' where user_id = $1`, [id], 'cp_owner')],
    ['échéance absolue dépassée', (id: string) => query(db, `update app.sessions set idle_expires_at = clock_timestamp() - interval '2 seconds', absolute_expires_at = clock_timestamp() - interval '1 second' where user_id = $1`, [id], 'cp_owner')],
    ['compte suspendu', (id: string) => query(db, `update app.users set status = 'SUSPENDED' where id = $1`, [id], 'cp_owner')],
  ])('session %s → 401 et effacement du cookie, en GET comme en POST, et reste invalide', async (_name, spoil) => {
    const s = await registerStudent(t.app, classId);
    await spoil(s.userId);
    for (const res of [
      await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token)),
      await send(t.app, 'POST', '/api/me/sessions/revoke-others', {}, cookieHeader(s.token)),
      await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token)),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBe(CLEAR);
    }
  });
  it.each([['SUSPENDED', 'SUSPENDED'], ['DELETED', 'ANONYMIZED']])('compte %s (puis ACTIVE si réactivable) : l’ancien cookie reste 401, session révoquée (%s)', async (status, reason) => {
    const s = await registerStudent(t.app, classId);
    // DELETED exige la ligne anonymisée complète (CHECK users_lifecycle) ; l'ancien cookie doit rester mort malgré le retour à ACTIVE.
    if (status === 'DELETED') await query(db, `update app.users set status = 'DELETED', email = null, first_name = null, last_name = null, password_hash = null, email_reminders = false, email_announcements = false, deleted_at = now() where id = $1`, [s.userId], 'cp_owner');
    else await query(db, `update app.users set status = $2::app.user_status where id = $1`, [s.userId, status], 'cp_owner');
    const first = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token));
    expect(first.statusCode).toBe(401);
    expect(first.headers['set-cookie']).toBe(CLEAR);
    // Une ligne anonymisée ne peut pas redevenir ACTIVE (users_lifecycle) : seul le cas SUSPENDED se réactive.
    if (status === 'SUSPENDED') await query(db, `update app.users set status = 'ACTIVE' where id = $1`, [s.userId], 'cp_owner');
    const again = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token));
    expect(again.statusCode).toBe(401);
    expect(again.headers['set-cookie']).toBe(CLEAR);
    expect((await query(db, `select revoke_reason::text as r from app.sessions where user_id = $1`, [s.userId])).rows).toEqual([{ r: reason }]);
  });
  it.each(['', 'not-a-token', 'a'.repeat(43), '<script>'])('cookie mal formé %j → 401', async (value) => {
    const res = await send(t.app, 'GET', '/api/me', undefined, { cookie: `__Host-cp_session=${value}` });
    expect(res.statusCode).toBe(401);
    // Un cookie vide équivaut à l'absence de cookie : rien à effacer ; tout autre jeton invalide est effacé.
    expect(res.headers['set-cookie']).toBe(value === '' ? undefined : CLEAR);
  });
  it('un jeton n’est jamais stocké en clair', async () => {
    const s = await registerStudent(t.app, classId);
    const r = await query(db, `select count(*)::int as n from app.sessions where token_hash = convert_to($1, 'UTF8') or encode(token_hash, 'base64') like '%' || $1 || '%'`, [s.token]);
    expect(r.rows[0].n).toBe(0);
  });
});

describe('sécurité — entrées et réponses', () => {
  it('aucun mot de passe, jeton, cookie ni autorisation dans les journaux (inscription, connexion, changement de mot de passe)', async () => {
    const newPassword = 'un autre mot de passe tres long 42';
    const bearer = 'Bearer secret-bearer-value-xyz';
    const s = await registerStudent(t.app, classId);
    const login = await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD }, { authorization: bearer });
    expect(login.statusCode).toBe(200);
    const tokenValue2 = /__Host-cp_session=([^;]+)/.exec(String(login.headers['set-cookie']))?.[1] ?? '';
    expect(tokenValue2).not.toBe('');
    const change = await send(t.app, 'POST', '/api/me/password', { currentPassword: PASSWORD, newPassword }, { ...cookieHeader(tokenValue2), authorization: bearer });
    expect(change.statusCode).toBeLessThan(300);
    await send(t.app, 'GET', '/api/me', undefined, { ...cookieHeader(s.token), authorization: bearer });
    const all = logs.join('');
    // Témoin : les requêtes sont bien journalisées, mais le sérialiseur n'écrit jamais d'en-têtes (ni cookie, ni autorisation).
    const lines = logs.flatMap((chunk) => chunk.split('\n')).filter(Boolean).map((l) => JSON.parse(l) as { req?: Record<string, unknown> });
    const meLine = lines.find((l) => l.req?.url === '/api/me');
    expect(meLine).toBeDefined();
    expect(Object.keys(meLine!.req!).sort()).toEqual(['id', 'ip', 'method', 'url']);
    expect(all).not.toMatch(/"(cookie|authorization|set-cookie)"/i);
    for (const secret of [PASSWORD, newPassword, s.token, tokenValue2, 'secret-bearer-value-xyz']) expect(all).not.toContain(secret);
  });
  it('les DTO ne renvoient jamais le hachage, le statut interne ni l’IP', async () => {
    const s = await registerStudent(t.app, classId);
    const me = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token));
    const sessions = await send(t.app, 'GET', '/api/me/sessions', undefined, cookieHeader(s.token));
    expect(me.body).not.toMatch(/argon2|passwordHash|"status":"ACTIVE"/);
    expect(sessions.body).not.toMatch(/\bip\b|198\.18\./);
  });
  it.each(['/api/docs', '/api/openapi.json', '/api-json', '/docs'])('OpenAPI absente : %s → 404 (arbitrage P)', async (url) => {
    expect((await send(t.app, 'GET', url)).statusCode).toBe(404);
  });
  it('les erreurs portent un requestId égal à x-request-id et aucune trace', async () => {
    const res = await send(t.app, 'POST', '/api/auth/login', { email: 'x@example.com', password: 'y' });
    expect(res.json().requestId).toBe(res.headers['x-request-id']);
    expect(res.body).not.toMatch(/at \w+ \(|\.ts:\d+/);
  });
});

describe('sécurité — limitation générale avant toute lecture en base', () => {
  // Épingle l'ordre « garde de limitation avant garde de session » : le 429 passe avant le 401.
  it('un flot de cookies invalides depuis une IP finit en 429, pas en 401 indéfiniment', async () => {
    const local = await buildTestApp(db, { config: { limits: { loginPerIp: 100, throttlePerIp: 5, throttlePerSession: 10_000 } } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await send(local.app, 'GET', '/api/me', undefined, { cookie: `__Host-cp_session=${'b'.repeat(43)}` }, '203.0.113.99')).statusCode);
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes.at(-1)).toBe(429);
    } finally {
      await local.close();
    }
  });
  // Épingle l'ordre « garde de limitation avant garde de session » (ici sans cookie, route publique).
  it('un flot anonyme sur une route publique finit en 429 avec Retry-After', async () => {
    const local = await buildTestApp(db, { config: { limits: { loginPerIp: 100, throttlePerIp: 3, throttlePerSession: 10_000 } } });
    try {
      const res = [];
      for (let i = 0; i < 5; i++) res.push(await send(local.app, 'GET', '/api/classes/active', undefined, {}, '203.0.113.98'));
      expect(res.slice(0, 3).map((r) => r.statusCode)).toEqual([200, 200, 200]);
      expect(res[4]?.statusCode).toBe(429);
      expect(res[4]?.headers['retry-after']).toBeTruthy();
    } finally {
      await local.close();
    }
  });
});
