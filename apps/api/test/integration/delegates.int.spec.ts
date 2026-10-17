import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, PASSWORD, registerStudent, send, type TestApp } from '../support/app.js';
import { connectAs, createTestDatabase } from '../support/pg.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { loginAdmin } from '../support/second-factor.js';

let db: string;
let t: TestApp;
let sql: pg.Client;
let classA: string;
let classB: string;
let admin: { headers: Record<string, string> };
let admin2: { headers: Record<string, string> };
let d1: { token: string; userId: string };
let a1: string;
let b1: string;
let b2: string;
let b3: string;

/** Décision et appartenance posées en SQL : la préparation précède l'API. */
async function acceptAndJoin(userId: string, classId: string, role: 'STUDENT' | 'DELEGATE'): Promise<void> {
  await sql.query(
    `update app.enrollment_requests set status = 'ACCEPTED', decided_at = now(), decided_by = $2 where user_id = $1 and class_id = $3 and status = 'PENDING'`,
    [userId, userId, classId],
  );
  await sql.query(`insert into app.class_memberships (id, user_id, class_id, role) values (gen_random_uuid(), $1, $2, $3)`, [userId, classId, role]);
}

async function joinAs(classId: string, role: 'STUDENT' | 'DELEGATE'): Promise<{ token: string; userId: string }> {
  const s = await registerStudent(t.app, classId);
  await acceptAndJoin(s.userId, classId, role);
  return s;
}

const reauth = async (headers: Record<string, string>): Promise<void> => {
  const r = await send(t.app, 'POST', '/api/me/reauth', { password: PASSWORD }, headers);
  expect(r.statusCode).toBe(204);
};

const roleOf = async (userId: string, classId: string): Promise<string | undefined> =>
  (await sql.query(`select role from app.class_memberships where user_id = $1 and class_id = $2 and left_at is null`, [userId, classId])).rows[0]?.role;

const auditCount = async (action: string, targetId: string): Promise<number> =>
  (await sql.query(`select count(*)::int as n from app.audit_log where action = $1 and target_id = $2`, [action, targetId])).rows[0]?.n as number;

const errorOf = (res: { json: () => unknown }): Record<string, unknown> => (res.json() as { error: Record<string, unknown> }).error;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = await connectAs('cp_app', db);
  t = await buildTestApp(db);
  classA = await insertClass(db, 'L3 Informatique A');
  classB = await insertClass(db, 'L3 Informatique B');
  d1 = await joinAs(classA, 'DELEGATE');
  a1 = (await joinAs(classA, 'STUDENT')).userId;
  b1 = (await joinAs(classB, 'STUDENT')).userId;
  b2 = (await joinAs(classB, 'STUDENT')).userId;
  b3 = (await joinAs(classB, 'STUDENT')).userId;
  admin = await loginAdmin(t.app, db);
  admin2 = await loginAdmin(t.app, db);
});

afterAll(async () => {
  await sql.end();
  await t.close();
});

describe('POST /api/classes/:classId/delegates (M12, nomination par l’admin)', () => {
  it('l’admin nomme un délégué : rôle DELEGATE, audit DELEGATE_APPOINTED', async () => {
    await reauth(admin.headers);
    const res = await send(t.app, 'POST', `/api/classes/${classA}/delegates`, { userId: a1 }, admin.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: a1, role: 'DELEGATE' });
    expect(await roleOf(a1, classA)).toBe('DELEGATE');
    const a = await sql.query(
      `select action, target_type, target_id, metadata from app.audit_log where action = 'DELEGATE_APPOINTED' and target_id = $1`,
      [a1],
    );
    expect(a.rows[0]).toEqual({ action: 'DELEGATE_APPOINTED', target_type: 'USER', target_id: a1, metadata: { classId: classA, userId: a1 } });
  });

  it('un délégué ne nomme personne → 403 FORBIDDEN', async () => {
    const target = await joinAs(classA, 'STUDENT');
    const res = await send(t.app, 'POST', `/api/classes/${classA}/delegates`, { userId: target.userId }, cookieHeader(d1.token));
    expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'FORBIDDEN' }]);
    expect(await roleOf(target.userId, classA)).toBe('STUDENT');
  });

  it('sans ressaisie récente du mot de passe → 403 REAUTH_REQUIRED, le membre est inchangé', async () => {
    const target = await joinAs(classA, 'STUDENT');
    const res = await send(t.app, 'POST', `/api/classes/${classA}/delegates`, { userId: target.userId }, admin2.headers);
    expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'REAUTH_REQUIRED' }]);
    expect(await roleOf(target.userId, classA)).toBe('STUDENT');
  });

  it('un membre d’une autre classe ou un utilisateur inconnu → 404 identiques', async () => {
    const foreign = await send(t.app, 'POST', `/api/classes/${classA}/delegates`, { userId: b1 }, admin.headers);
    const unknown = await send(t.app, 'POST', `/api/classes/${classA}/delegates`, { userId: uuidv7() }, admin.headers);
    expect([foreign.statusCode, errorOf(foreign)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect([unknown.statusCode, errorOf(unknown)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect(await roleOf(b1, classB)).toBe('STUDENT');
  });

  it('classe archivée → 409 CLASS_ARCHIVED', async () => {
    const classC = await insertClass(db, 'L3 Archivée C');
    const c1 = await joinAs(classC, 'STUDENT');
    await sql.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [classC]);
    const res = await send(t.app, 'POST', `/api/classes/${classC}/delegates`, { userId: c1.userId }, admin.headers);
    expect([res.statusCode, errorOf(res)]).toEqual([409, { code: 'CLASS_ARCHIVED' }]);
  });

  it('3 nominations concurrentes, limite de 2 : 2 passent, verrou observé, la 3e reçoit DELEGATE_LIMIT_REACHED', async () => {
    await reauth(admin.headers);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0]?.pid as number;
    await holder.query('select id from app.classes where id = $1 for no key update', [classB]);
    const pending = Promise.all([b1, b2, b3].map((u) => send(t.app, 'POST', `/api/classes/${classB}/delegates`, { userId: u }, admin.headers)));
    await waitForLockWait(db, pid); // les trois transactions attendent le verrou `classes` (§ 2.1)
    await holder.query('commit');
    await holder.end();
    const results = await pending;
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 409]);
    const refused = results.find((r) => r.statusCode === 409);
    expect(errorOf(refused!)).toEqual({ code: 'DELEGATE_LIMIT_REACHED' });
    const n = await sql.query(`select count(*)::int as n from app.class_memberships where class_id = $1 and role = 'DELEGATE' and left_at is null`, [classB]);
    expect(n.rows[0]?.n).toBe(2); // la limite tient même en concurrence (§ 0.2, R8)
  });
});

describe('DELETE /api/classes/:classId/delegates/:userId (M12, révocation)', () => {
  it('l’admin révoque : rôle STUDENT, audit DELEGATE_REVOKED', async () => {
    await reauth(admin.headers);
    const res = await send(t.app, 'DELETE', `/api/classes/${classA}/delegates/${a1}`, {}, admin.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: a1, role: 'STUDENT' });
    expect(await roleOf(a1, classA)).toBe('STUDENT');
    const a = await sql.query(
      `select action, target_type, target_id, metadata from app.audit_log where action = 'DELEGATE_REVOKED' and target_id = $1`,
      [a1],
    );
    expect(a.rows[0]).toEqual({ action: 'DELEGATE_REVOKED', target_type: 'USER', target_id: a1, metadata: { classId: classA, userId: a1 } });
  });

  it('révoquer à nouveau est sans effet : 200 inchangé, aucun nouvel audit', async () => {
    const before = await auditCount('DELEGATE_REVOKED', a1);
    const res = await send(t.app, 'DELETE', `/api/classes/${classA}/delegates/${a1}`, {}, admin.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: a1, role: 'STUDENT' });
    expect(await auditCount('DELEGATE_REVOKED', a1)).toBe(before);
  });
});
