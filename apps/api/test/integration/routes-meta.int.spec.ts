import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, ORIGIN, PASSWORD, registerStudent, registration, send, type TestApp } from '../support/app.js';
import { createTestDatabase } from '../support/pg.js';

/** Toute route de l'API doit figurer ici (R11). `public` : accessible sans session. */
const EXPECTED_ROUTES: Record<string, { public: boolean }> = {
  'GET /api/health': { public: true },
  'GET /api/classes/active': { public: true },
  'POST /api/auth/register': { public: true },
  'POST /api/auth/login': { public: true },
  'POST /api/auth/verify-code': { public: true },
  'POST /api/auth/verify-recovery': { public: true },
  'POST /api/auth/resend-code': { public: true },
  'POST /api/auth/logout': { public: false },
  'GET /api/me': { public: false },
  'PATCH /api/me/profile': { public: false },
  'PATCH /api/me/email-preferences': { public: false },
  'POST /api/me/password': { public: false },
  'GET /api/me/sessions': { public: false },
  'POST /api/me/sessions/revoke-others': { public: false },
};

let t: TestApp;
let classId: string;
beforeAll(async () => {
  const db = await createTestDatabase();
  classId = await insertClass(db, 'L3 Informatique');
  t = await buildTestApp(db);
});
afterAll(async () => { await t.close(); });

const entries = () => Object.entries(EXPECTED_ROUTES).map(([k, v]) => {
  const [method, url] = k.split(' ') as ['GET' | 'POST' | 'PATCH', string];
  return { key: k, method, url, ...v };
});
/** Corps valide par route modifiante : la sonde « champ inconnu » ajoute `__x` à un corps qui passe la validation. */
const VALID_BODY: Record<string, () => Record<string, unknown>> = {
  'POST /api/auth/register': () => registration(classId),
  'POST /api/auth/login': () => ({ email: 'inconnu@example.com', password: PASSWORD }),
  'POST /api/auth/verify-code': () => ({ code: '123456' }),
  'POST /api/auth/verify-recovery': () => ({ recoveryCode: 'ABCD-EFGH-JKMN' }),
  'POST /api/auth/resend-code': () => ({}),
  'POST /api/auth/logout': () => ({}),
  'PATCH /api/me/profile': () => ({ firstName: 'Awa', lastName: 'Diop' }),
  'PATCH /api/me/email-preferences': () => ({ emailReminders: false }),
  'POST /api/me/password': () => ({ currentPassword: PASSWORD, newPassword: 'un autre mot de passe tres long 42' }),
  'POST /api/me/sessions/revoke-others': () => ({}),
};

const modifying = () => entries().filter((r) => r.method !== 'GET');

describe('méta-test des routes (§ 5.4, R11)', () => {
  it('la liste des routes déclarées est exactement la table attendue', () => {
    expect(t.routes.map((r) => `${r.method} ${r.url}`).sort()).toEqual(Object.keys(EXPECTED_ROUTES).sort());
  });
  it.each(entries().filter((r) => !r.public))('$key : 401 sans session', async ({ method, url }) => {
    const res = await send(t.app, method, url, {});
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });
  it.each(modifying())('$key : 403 CSRF avec une origine étrangère', async ({ method, url }) => {
    const res = await send(t.app, method, url, {}, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_REJECTED');
  });
  it.each(modifying())('$key : 415 si le corps n’est pas du JSON', async ({ method, url }) => {
    const res = await t.app.inject({ method, url, payload: 'a=b', headers: { origin: ORIGIN, 'content-type': 'text/plain' } });
    expect(res.statusCode).toBe(415);
  });
  it('chaque route modifiante a un corps valide déclaré', () => {
    expect(Object.keys(VALID_BODY).sort()).toEqual(modifying().map((r) => r.key).sort());
  });
  it.each(modifying())('$key : le corps valide seul ne donne pas 400 VALIDATION_FAILED (témoin)', async ({ key, method, url }) => {
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, method, url, VALID_BODY[key]!(), cookieHeader(s.token));
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body ? res.json().error?.code : undefined).not.toBe('VALIDATION_FAILED');
  });
  it.each(modifying())('$key : corps valide + champ inconnu → 400 VALIDATION_FAILED, jamais 2xx ni 500', async ({ key, method, url }) => {
    const s = await registerStudent(t.app, classId); // une session neuve par sonde (la déconnexion en consomme une)
    const res = await send(t.app, method, url, { ...VALID_BODY[key]!(), __x: 1 }, cookieHeader(s.token));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.json().requestId).toBeTruthy();
  });
});
