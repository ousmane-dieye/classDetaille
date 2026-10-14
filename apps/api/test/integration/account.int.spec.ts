import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, PASSWORD, query, registerStudent, send, sessionCookieOf, type TestApp } from '../support/app.js';
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

const NEW_PASSWORD = 'une autre phrase de passe bien longue';

describe('GET /api/me', () => {
  it('200 : profil et demande en attente ; 401 sans session', async () => {
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: s.userId, email: s.email, enrollment: { status: 'PENDING', class: { id: classId } } });
    expect(res.json()).not.toHaveProperty('passwordHash');
    expect((await send(t.app, 'GET', '/api/me')).statusCode).toBe(401);
  });
  it('refus : motif et date de nouvelle demande (24 h après la décision)', async () => {
    const s = await registerStudent(t.app, classId);
    await query(db, `update app.enrollment_requests set status = 'REFUSED', decided_at = '2026-10-14T10:00:00Z', decided_by = user_id, decision_note = 'Classe complète' where user_id = $1`, [s.userId], 'cp_owner');
    const me = (await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token))).json();
    expect(me.enrollment).toMatchObject({ status: 'REFUSED', decisionNote: 'Classe complète', decidedAt: '2026-10-14T10:00:00.000Z', retryAfter: '2026-10-15T10:00:00.000Z' });
  });
});

describe('PATCH /api/me/profile et /api/me/email-preferences', () => {
  it('normalise les noms ; champ inconnu → 400 ; nom trop court → 400', async () => {
    const s = await registerStudent(t.app, classId);
    const ok = await send(t.app, 'PATCH', '/api/me/profile', { firstName: '  Fatou  Binetou ', lastName: 'Ndiaye' }, cookieHeader(s.token));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ firstName: 'Fatou Binetou', lastName: 'Ndiaye' });
    expect((await send(t.app, 'PATCH', '/api/me/profile', { firstName: 'Fatou', lastName: 'Ndiaye', email: 'x@example.com' }, cookieHeader(s.token))).statusCode).toBe(400);
    expect((await send(t.app, 'PATCH', '/api/me/profile', { firstName: 'F', lastName: 'Ndiaye' }, cookieHeader(s.token))).json().error).toEqual({ code: 'VALIDATION_FAILED', fields: ['firstName'] });
  });
  it('préférences : un seul champ suffit ; corps vide → 400', async () => {
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'PATCH', '/api/me/email-preferences', { emailReminders: false }, cookieHeader(s.token));
    expect(res.json()).toMatchObject({ emailReminders: false, emailAnnouncements: true });
    expect((await send(t.app, 'PATCH', '/api/me/email-preferences', {}, cookieHeader(s.token))).statusCode).toBe(400);
  });
});

describe('POST /api/me/password (P10)', () => {
  it('204 : nouveau mot de passe, autres sessions révoquées, session courante gardée, audit', async () => {
    const s = await registerStudent(t.app, classId);
    const other = sessionCookieOf(await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD }))!;
    const res = await send(t.app, 'POST', '/api/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, cookieHeader(s.token));
    expect(res.statusCode).toBe(204);
    expect((await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token))).statusCode).toBe(200);
    expect((await send(t.app, 'GET', '/api/me', undefined, cookieHeader(other))).statusCode).toBe(401);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD })).statusCode).toBe(401);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: NEW_PASSWORD })).statusCode).toBe(200);
    const audit = await query(db, `select metadata from app.audit_log where action = 'PASSWORD_CHANGED' and target_id = $1`, [s.userId]);
    expect(audit.rows).toEqual([{ metadata: { revokedSessions: 1 } }]);
    const reasons = await query(db, `select revoke_reason from app.sessions where user_id = $1 and revoked_at is not null`, [s.userId]);
    expect(reasons.rows).toEqual([{ revoke_reason: 'PASSWORD_CHANGED' }]);
  });
  it('mot de passe actuel faux → 400 CURRENT_PASSWORD_INVALID (jamais 401, la session reste valide)', async () => {
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'POST', '/api/me/password', { currentPassword: 'faux mot de passe long', newPassword: NEW_PASSWORD }, cookieHeader(s.token));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CURRENT_PASSWORD_INVALID');
    expect((await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token))).statusCode).toBe(200);
  });
  it('R6 : les mots de passe actuels faux comptent comme échecs IP + compte → 429 TOO_MANY_ATTEMPTS', async () => {
    const s = await registerStudent(t.app, classId);
    const ip = '203.0.113.77';
    const wrong = () => send(t.app, 'POST', '/api/me/password', { currentPassword: 'faux mot de passe long', newPassword: NEW_PASSWORD }, cookieHeader(s.token), ip);
    expect((await wrong()).statusCode).toBe(400);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await wrong()).statusCode);
    expect(codes).toContain(429);
  });
  it.each([['a'.repeat(14), 'PASSWORD_TOO_SHORT'], ['a'.repeat(129), 'PASSWORD_TOO_LONG']])('nouveau mot de passe refusé %#', async (newPassword, code) => {
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'POST', '/api/me/password', { currentPassword: PASSWORD, newPassword }, cookieHeader(s.token));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });
});

describe('sessions actives', () => {
  it('liste avec « cet appareil », puis déconnexion des autres appareils', async () => {
    const s = await registerStudent(t.app, classId);
    await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD }, { 'user-agent': 'Téléphone' });
    const list = (await send(t.app, 'GET', '/api/me/sessions', undefined, cookieHeader(s.token))).json() as { current: boolean; userAgent: string | null }[];
    expect(list).toHaveLength(2);
    expect(list.filter((x) => x.current)).toHaveLength(1);
    expect(list.map((x) => x.userAgent)).toContain('Téléphone');
    const res = await send(t.app, 'POST', '/api/me/sessions/revoke-others', {}, cookieHeader(s.token));
    expect(res.json()).toEqual({ revoked: 1 });
    expect((await send(t.app, 'GET', '/api/me/sessions', undefined, cookieHeader(s.token))).json()).toHaveLength(1);
    const audit = await query(db, `select metadata from app.audit_log where action = 'SESSIONS_REVOKED' and target_id = $1`, [s.userId]);
    expect(audit.rows).toEqual([{ metadata: { reason: 'OTHER_DEVICES', count: 1 } }]);
  });
});
