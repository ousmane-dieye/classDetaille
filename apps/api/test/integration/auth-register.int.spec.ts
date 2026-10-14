import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, insertClass, PASSWORD, query, registration, send, sessionCookieOf, type TestApp } from '../support/app.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let classId: string;
let archivedId: string;
beforeAll(async () => {
  db = await createTestDatabase();
  classId = await insertClass(db, 'L3 Informatique');
  archivedId = await insertClass(db, 'L2 Ancienne', { year: '2024-2025', archived: true });
  t = await buildTestApp(db);
});
afterAll(async () => { await t.close(); });

describe('POST /api/auth/register (P1, § 0.3)', () => {
  it('crée le compte, la demande en attente, l’audit et une session, en une transaction', async () => {
    const body = registration(classId, { email: '  Awa.Diop@Example.COM ' });
    const res = await send(t.app, 'POST', '/api/auth/register', body);
    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toMatch(/^__Host-cp_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const me = res.json();
    expect(me).toMatchObject({
      email: 'awa.diop@example.com', firstName: 'Awa', lastName: 'Diop', globalRole: 'USER', emailReminders: true, emailAnnouncements: true,
      enrollment: { status: 'PENDING', class: { id: classId, name: 'L3 Informatique', level: 'L3', academicYear: '2026-2027' }, decidedAt: null, retryAfter: null },
    });
    expect(res.body).not.toContain(PASSWORD);
    const rows = await query(db, `select (select count(*)::int from app.enrollment_requests where user_id = $1 and status = 'PENDING') as req,
      (select count(*)::int from app.sessions where user_id = $1) as sess,
      (select metadata from app.audit_log where action = 'ACCOUNT_REGISTERED' and target_id = $1) as audit,
      (select password_hash from app.users where id = $1) as hash`, [me.id]);
    expect(rows.rows[0]).toMatchObject({ req: 1, sess: 1, audit: { classId, enrollmentRequestId: me.enrollment.id } });
    expect(rows.rows[0].hash).toMatch(/^\$argon2id\$/);
  });
  it('variantes du même email → 409 EMAIL_TAKEN (casse, espaces, pleine largeur)', async () => {
    await send(t.app, 'POST', '/api/auth/register', registration(classId, { email: 'fatou@example.com' }));
    for (const email of ['FATOU@example.com', ' fatou@example.com', 'ｆａｔｏｕ@example.com']) {
      const res = await send(t.app, 'POST', '/api/auth/register', registration(classId, { email }));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_TAKEN');
    }
  });

  describe('inscriptions simultanées avec le même email (attente de verrou observée)', () => {
    const INSERT_USER = `insert into app.users (id, email, first_name, last_name, password_hash, global_role, status, created_at, updated_at)
      values ($1, $2, 'Hold', 'Er', 'x', 'USER', 'ACTIVE', now(), now())`;

    async function holdThenRegister(email: string, outcome: 'COMMIT' | 'ROLLBACK') {
      const holder = await connectAs('cp_app', db);
      const admin = await connectAs('postgres', db);
      try {
        await holder.query('begin');
        await holder.query(INSERT_USER, [uuidv7(), email]);
        const holderPid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
        const pending = send(t.app, 'POST', '/api/auth/register', registration(classId, { email }));
        // L'inscription doit attendre un verrou tenu par la transaction non validée du titulaire.
        let waiting = 0;
        for (let i = 0; i < 100 && waiting === 0; i++) {
          const r = await admin.query(
            `select count(*)::int as n from pg_stat_activity where datname = $1 and usename = 'cp_app' and pid <> $2 and wait_event_type = 'Lock'`, [db, holderPid]);
          waiting = r.rows[0].n;
          if (waiting === 0) await new Promise((res) => setTimeout(res, 50));
        }
        expect(waiting).toBeGreaterThan(0);
        await holder.query(outcome);
        return await pending;
      } finally {
        await holder.end();
        await admin.end();
      }
    }

    it('le titulaire valide : 409 EMAIL_TAKEN, jamais 500, aucune demande créée', async () => {
      const res = await holdThenRegister('lock-commit@example.com', 'COMMIT');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_TAKEN');
      expect(sessionCookieOf(res)).toBeUndefined();
      const n = await query(db, `select (select count(*)::int from app.users where email = 'lock-commit@example.com') as u,
        (select count(*)::int from app.enrollment_requests r join app.users x on x.id = r.user_id where x.email = 'lock-commit@example.com') as r`);
      expect(n.rows[0]).toEqual({ u: 1, r: 0 });
    });
    it('le titulaire annule : l’inscription aboutit', async () => {
      const res = await holdThenRegister('lock-rollback@example.com', 'ROLLBACK');
      expect(res.statusCode).toBe(201);
      expect(res.json().email).toBe('lock-rollback@example.com');
      expect((await query(db, `select count(*)::int as n from app.users where email = 'lock-rollback@example.com'`)).rows[0].n).toBe(1);
    });
    it('deux inscriptions parallèles : une 201, une 409', async () => {
      const body = registration(classId, { email: 'twin@example.com' });
      const [a, b] = await Promise.all([send(t.app, 'POST', '/api/auth/register', body), send(t.app, 'POST', '/api/auth/register', body)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
      expect((await query(db, `select count(*)::int as n from app.users where email = 'twin@example.com'`)).rows[0].n).toBe(1);
    });
  });

  it.each([
    [{ password: 'a'.repeat(14) }, 'PASSWORD_TOO_SHORT'],
    [{ password: 'a'.repeat(129) }, 'PASSWORD_TOO_LONG'],
  ])('mot de passe refusé %#', async (over, code) => {
    const res = await send(t.app, 'POST', '/api/auth/register', registration(classId, over));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });
  it('classe archivée ou inconnue → 400 CLASS_NOT_AVAILABLE, rien n’est créé', async () => {
    for (const id of [archivedId, '0192b1c4-5d6e-7f80-9a1b-2c3d4e5f6a7b']) {
      const body = registration(id);
      const res = await send(t.app, 'POST', '/api/auth/register', body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CLASS_NOT_AVAILABLE');
      expect((await query(db, `select count(*)::int as n from app.users where email = $1`, [body.email])).rows[0].n).toBe(0);
    }
  });
  it('classId qui n’est pas un UUID → 400 VALIDATION_FAILED, jamais 500', async () => {
    const res = await send(t.app, 'POST', '/api/auth/register', registration('pas-un-uuid'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: 'VALIDATION_FAILED', fields: ['classId'] });
  });
  it('email non ASCII → 400 VALIDATION_FAILED sur email ; champ inconnu → 400', async () => {
    const res = await send(t.app, 'POST', '/api/auth/register', registration(classId, { email: 'élise@example.com' }));
    expect(res.json().error).toEqual({ code: 'VALIDATION_FAILED', fields: ['email'] });
    expect((await send(t.app, 'POST', '/api/auth/register', registration(classId, { globalRole: 'ADMIN' }))).statusCode).toBe(400);
  });
  it('Turnstile refusé → 400 TURNSTILE_FAILED ; indisponible (3 erreurs) → 503 SIGNUP_UNAVAILABLE + Retry-After', async () => {
    const local = await buildTestApp(db);
    try {
      local.turnstile.next = 'invalid';
      const r1 = await send(local.app, 'POST', '/api/auth/register', registration(classId));
      expect(r1.statusCode).toBe(400);
      expect(r1.json().error.code).toBe('TURNSTILE_FAILED');
      local.turnstile.next = 'error';
      for (let i = 0; i < 3; i++) await send(local.app, 'POST', '/api/auth/register', registration(classId));
      const r2 = await send(local.app, 'POST', '/api/auth/register', registration(classId));
      expect(r2.statusCode).toBe(503);
      expect(r2.json().error.code).toBe('SIGNUP_UNAVAILABLE');
      expect(Number(r2.headers['retry-after'])).toBeGreaterThan(0);
      expect(sessionCookieOf(r2)).toBeUndefined();
    } finally {
      await local.close();
    }
  });
});
