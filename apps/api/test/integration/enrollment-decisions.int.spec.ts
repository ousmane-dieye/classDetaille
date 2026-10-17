import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { connectAs, createTestDatabase } from '../support/pg.js';
import { loginAdmin } from '../support/second-factor.js';

let db: string;
let t: TestApp;
let sql: pg.Client;
let owner: pg.Client;
let classA: string;
let classB: string;
let delegateA: { token: string; userId: string };
let delegateB: { token: string; userId: string };
let admin: { headers: Record<string, string> };

/** Décision et appartenance posées en SQL : la préparation précède l'API de la tâche 2. */
async function acceptAndJoin(userId: string, classId: string, role: 'STUDENT' | 'DELEGATE'): Promise<void> {
  await sql.query(
    `update app.enrollment_requests set status = 'ACCEPTED', decided_at = now(), decided_by = $2 where user_id = $1 and class_id = $3 and status = 'PENDING'`,
    [userId, userId, classId],
  );
  await sql.query(`insert into app.class_memberships (id, user_id, class_id, role) values (gen_random_uuid(), $1, $2, $3)`, [userId, classId, role]);
}

async function refuseInSql(userId: string, classId: string, decidedAt: string): Promise<void> {
  await owner.query(
    `update app.enrollment_requests set status = 'REFUSED', decided_at = ${decidedAt}, decided_by = $1 where user_id = $1 and class_id = $2 and status = 'PENDING'`,
    [userId, classId],
  );
}

async function pendingId(userId: string, classId: string): Promise<string> {
  const r = await sql.query(`select id from app.enrollment_requests where user_id = $1 and class_id = $2 and status = 'PENDING'`, [userId, classId]);
  return r.rows[0]?.id as string;
}

const errorOf = (res: { json: () => unknown }): Record<string, unknown> => (res.json() as { error: Record<string, unknown> }).error;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = await connectAs('cp_app', db);
  owner = await connectAs('cp_owner', db);
  t = await buildTestApp(db);
  classA = await insertClass(db, 'L3 Informatique A');
  classB = await insertClass(db, 'L3 Informatique B');
  const dA = await registerStudent(t.app, classA);
  await acceptAndJoin(dA.userId, classA, 'DELEGATE');
  delegateA = { token: dA.token, userId: dA.userId };
  const dB = await registerStudent(t.app, classB);
  await acceptAndJoin(dB.userId, classB, 'DELEGATE');
  delegateB = { token: dB.token, userId: dB.userId };
  admin = await loginAdmin(t.app, db);
});

afterAll(async () => {
  await sql.end();
  await owner.end();
  await t.close();
});

describe('GET /api/classes/:classId/requests (P8)', () => {
  it('le délégué voit les demandes en attente, avec l’email', async () => {
    const s = await registerStudent(t.app, classA);
    const res = await send(t.app, 'GET', `/api/classes/${classA}/requests`, {}, cookieHeader(delegateA.token));
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    const mine = rows.find((r) => (r.user as { email: string }).email === s.email);
    expect(mine).toMatchObject({ status: 'PENDING', user: { firstName: 'Awa', lastName: 'Diop', email: s.email } });
    expect(typeof mine?.createdAt).toBe('string');
  });

  it('un membre étudiant de la classe → 403 FORBIDDEN', async () => {
    const m = await registerStudent(t.app, classA);
    await acceptAndJoin(m.userId, classA, 'STUDENT');
    const res = await send(t.app, 'GET', `/api/classes/${classA}/requests`, {}, cookieHeader(m.token));
    expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'FORBIDDEN' }]);
  });

  it('un délégué d’une autre classe → 404 (isolation)', async () => {
    const res = await send(t.app, 'GET', `/api/classes/${classA}/requests`, {}, cookieHeader(delegateB.token));
    expect([res.statusCode, errorOf(res)]).toEqual([404, { code: 'NOT_FOUND' }]);
  });
});

describe('POST /api/classes/:classId/requests/:requestId/accept', () => {
  it('accepte : demande ACCEPTED, appartenance STUDENT active, audit', async () => {
    const s = await registerStudent(t.app, classA);
    const reqId = await pendingId(s.userId, classA);
    const res = await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/accept`, {}, cookieHeader(delegateA.token));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ACCEPTED', membership: { classId: classA, role: 'STUDENT' } });
    expect(typeof (res.json() as { decidedAt: string }).decidedAt).toBe('string');
    const r = await sql.query(`select status, decided_by from app.enrollment_requests where id = $1`, [reqId]);
    expect(r.rows[0]).toEqual({ status: 'ACCEPTED', decided_by: delegateA.userId });
    const m = await sql.query(`select role from app.class_memberships where user_id = $1 and class_id = $2 and left_at is null`, [s.userId, classA]);
    expect(m.rows).toEqual([{ role: 'STUDENT' }]);
    const a = await sql.query(`select action, target_type, target_id, metadata from app.audit_log where action = 'ENROLLMENT_ACCEPTED' and target_id = $1`, [reqId]);
    expect(a.rows[0]).toEqual({ action: 'ENROLLMENT_ACCEPTED', target_type: 'ENROLLMENT_REQUEST', target_id: reqId, metadata: { classId: classA, userId: s.userId } });
  });

  it('une seconde décision sur la même demande → 409 REQUEST_ALREADY_DECIDED', async () => {
    const s = await registerStudent(t.app, classA);
    const reqId = await pendingId(s.userId, classA);
    await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/accept`, {}, cookieHeader(delegateA.token));
    const again = await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/accept`, {}, cookieHeader(delegateA.token));
    expect([again.statusCode, errorOf(again)]).toEqual([409, { code: 'REQUEST_ALREADY_DECIDED' }]);
    const m = await sql.query(`select count(*)::int as n from app.class_memberships where user_id = $1 and class_id = $2`, [s.userId, classA]);
    expect(m.rows[0]?.n).toBe(1);
  });

  it('l’admin accepte aussi', async () => {
    const s = await registerStudent(t.app, classA);
    const reqId = await pendingId(s.userId, classA);
    const res = await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/accept`, {}, admin.headers);
    expect(res.statusCode).toBe(200);
  });

  it('un membre étudiant de la classe → 403 FORBIDDEN', async () => {
    const m = await registerStudent(t.app, classA);
    await acceptAndJoin(m.userId, classA, 'STUDENT');
    const s = await registerStudent(t.app, classA);
    const reqId = await pendingId(s.userId, classA);
    const res = await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/accept`, {}, cookieHeader(m.token));
    expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'FORBIDDEN' }]);
  });

  it('un délégué d’une autre classe : 404 identique à une demande inexistante', async () => {
    const s = await registerStudent(t.app, classA);
    const reqId = await pendingId(s.userId, classA);
    const foreign = await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/accept`, {}, cookieHeader(delegateB.token));
    const unknown = await send(t.app, 'POST', `/api/classes/${classA}/requests/${uuidv7()}/accept`, {}, cookieHeader(delegateA.token));
    expect([foreign.statusCode, errorOf(foreign)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect([unknown.statusCode, errorOf(unknown)]).toEqual([404, { code: 'NOT_FOUND' }]);
    const r = await sql.query(`select status from app.enrollment_requests where id = $1`, [reqId]);
    expect(r.rows[0]?.status).toBe('PENDING');
  });

  it('classe inexistante → 404', async () => {
    const res = await send(t.app, 'POST', `/api/classes/${uuidv7()}/requests/${uuidv7()}/accept`, {}, cookieHeader(delegateA.token));
    expect([res.statusCode, errorOf(res)]).toEqual([404, { code: 'NOT_FOUND' }]);
  });
});

describe('POST /api/classes/:classId/requests/:requestId/refuse', () => {
  it('refuse : 204, motif enregistré, un seul email REFUSAL, audit', async () => {
    const s = await registerStudent(t.app, classA);
    const reqId = await pendingId(s.userId, classA);
    const res = await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/refuse`, { note: 'Classe complète' }, cookieHeader(delegateA.token));
    expect(res.statusCode).toBe(204);
    const r = await sql.query(`select status, decided_by, decision_note from app.enrollment_requests where id = $1`, [reqId]);
    expect(r.rows[0]).toEqual({ status: 'REFUSED', decided_by: delegateA.userId, decision_note: 'Classe complète' });
    const mail = await sql.query(`select kind, to_address, recipient_user_id, payload from app.email_outbox where dedupe_key = $1`, [`enrollment-refusal:${reqId}`]);
    expect(mail.rows).toHaveLength(1);
    expect(mail.rows[0]).toMatchObject({
      kind: 'REFUSAL',
      to_address: s.email,
      recipient_user_id: s.userId,
      payload: { className: 'L3 Informatique A', note: 'Classe complète' },
    });
    const a = await sql.query(`select action, target_type, target_id, metadata from app.audit_log where action = 'ENROLLMENT_REFUSED' and target_id = $1`, [reqId]);
    expect(a.rows[0]).toEqual({ action: 'ENROLLMENT_REFUSED', target_type: 'ENROLLMENT_REQUEST', target_id: reqId, metadata: { classId: classA, userId: s.userId } });
  });

  it('sans motif : 204, le payload ne porte aucune note', async () => {
    const s = await registerStudent(t.app, classA);
    const reqId = await pendingId(s.userId, classA);
    const res = await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/refuse`, {}, cookieHeader(delegateA.token));
    expect(res.statusCode).toBe(204);
    const mail = await sql.query(`select payload from app.email_outbox where dedupe_key = $1`, [`enrollment-refusal:${reqId}`]);
    expect(mail.rows[0]?.payload).toEqual({ className: 'L3 Informatique A' });
  });

  it('une demande déjà tranchée → 409, sans second email', async () => {
    const s = await registerStudent(t.app, classA);
    const reqId = await pendingId(s.userId, classA);
    await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/refuse`, { note: 'x' }, cookieHeader(delegateA.token));
    const again = await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/refuse`, { note: 'y' }, cookieHeader(delegateA.token));
    expect([again.statusCode, errorOf(again)]).toEqual([409, { code: 'REQUEST_ALREADY_DECIDED' }]);
    const mail = await sql.query(`select count(*)::int as n from app.email_outbox where dedupe_key = $1`, [`enrollment-refusal:${reqId}`]);
    expect(mail.rows[0]?.n).toBe(1);
  });

  it('un motif trop long → 400 VALIDATION_FAILED, la demande reste intacte', async () => {
    const s = await registerStudent(t.app, classA);
    const reqId = await pendingId(s.userId, classA);
    const res = await send(t.app, 'POST', `/api/classes/${classA}/requests/${reqId}/refuse`, { note: 'x'.repeat(501) }, cookieHeader(delegateA.token));
    expect([res.statusCode, errorOf(res).code]).toEqual([400, 'VALIDATION_FAILED']);
    const r = await sql.query(`select status from app.enrollment_requests where id = $1`, [reqId]);
    expect(r.rows[0]?.status).toBe('PENDING');
  });
});

describe('POST /api/me/enrollment (R16, § 0.3)', () => {
  it('moins de 24 h après le refus → 400 ENROLLMENT_RETRY_PENDING avec retryAfter', async () => {
    const s = await registerStudent(t.app, classA);
    await refuseInSql(s.userId, classA, `now() - interval '23 hours'`);
    const res = await send(t.app, 'POST', '/api/me/enrollment', { classId: classA }, cookieHeader(s.token));
    expect(res.statusCode).toBe(400);
    const err = errorOf(res) as { code: string; retryAfter: string };
    expect(err.code).toBe('ENROLLMENT_RETRY_PENDING');
    const at = new Date(err.retryAfter).getTime();
    // Refus posé à « maintenant − 23 h » : retryAfter = refus + 24 h ≈ maintenant + 1 h (horloge du conteneur).
    expect(at).toBeGreaterThan(Date.now() + 30 * 60_000);
    expect(at).toBeLessThan(Date.now() + 3 * 3600_000);
  });

  it('plus de 24 h après le refus → 201, nouvelle demande en attente', async () => {
    const s = await registerStudent(t.app, classA);
    await refuseInSql(s.userId, classA, `now() - interval '25 hours'`);
    const res = await send(t.app, 'POST', '/api/me/enrollment', { classId: classA }, cookieHeader(s.token));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'PENDING', retryAfter: null, class: { id: classA, name: 'L3 Informatique A' } });
    const r = await sql.query(`select status from app.enrollment_requests where user_id = $1 and class_id = $2 order by created_at desc limit 1`, [s.userId, classA]);
    expect(r.rows[0]?.status).toBe('PENDING');
  });

  it('une demande déjà en attente → 409 REQUEST_ALREADY_PENDING', async () => {
    const s = await registerStudent(t.app, classA);
    const res = await send(t.app, 'POST', '/api/me/enrollment', { classId: classA }, cookieHeader(s.token));
    expect([res.statusCode, errorOf(res)]).toEqual([409, { code: 'REQUEST_ALREADY_PENDING' }]);
  });

  it('un membre actif → 409 ALREADY_MEMBER', async () => {
    const m = await registerStudent(t.app, classA);
    await acceptAndJoin(m.userId, classA, 'STUDENT');
    const res = await send(t.app, 'POST', '/api/me/enrollment', { classId: classA }, cookieHeader(m.token));
    expect([res.statusCode, errorOf(res)]).toEqual([409, { code: 'ALREADY_MEMBER' }]);
  });

  it('classe inexistante → 400 CLASS_NOT_AVAILABLE', async () => {
    const res = await send(t.app, 'POST', '/api/me/enrollment', { classId: uuidv7() }, cookieHeader(delegateA.token));
    expect([res.statusCode, errorOf(res).code]).toEqual([400, 'CLASS_NOT_AVAILABLE']);
  });
});
