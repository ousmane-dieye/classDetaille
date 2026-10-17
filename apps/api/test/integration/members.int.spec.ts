import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, PASSWORD, registerStudent, send, type TestApp } from '../support/app.js';
import { connectAs, createTestDatabase } from '../support/pg.js';
import { loginAdmin } from '../support/second-factor.js';

let db: string;
let t: TestApp;
let sql: pg.Client;
let classA: string;
let classB: string;
let delegateA: { token: string; userId: string; password: string };
let delegateB: { token: string; userId: string };
let student1: { token: string; userId: string; email: string };
let admin: { headers: Record<string, string> };

/** Décision et appartenance posées en SQL : la préparation précède l'API (tâches 2 et 3). */
async function acceptAndJoin(userId: string, classId: string, role: 'STUDENT' | 'DELEGATE'): Promise<void> {
  await sql.query(
    `update app.enrollment_requests set status = 'ACCEPTED', decided_at = now(), decided_by = $2 where user_id = $1 and class_id = $3 and status = 'PENDING'`,
    [userId, userId, classId],
  );
  await sql.query(`insert into app.class_memberships (id, user_id, class_id, role) values (gen_random_uuid(), $1, $2, $3)`, [userId, classId, role]);
}

async function joinAs(classId: string, role: 'STUDENT' | 'DELEGATE'): Promise<{ token: string; userId: string; password: string; email: string }> {
  const s = await registerStudent(t.app, classId);
  await acceptAndJoin(s.userId, classId, role);
  return s;
}

const reauth = async (headers: Record<string, string>): Promise<void> => {
  const r = await send(t.app, 'POST', '/api/me/reauth', { password: PASSWORD }, headers);
  expect(r.statusCode).toBe(204);
};

const membershipOf = async (userId: string, classId: string) =>
  (await sql.query(`select left_at, left_reason, left_by, left_note from app.class_memberships where user_id = $1 and class_id = $2`, [userId, classId])).rows[0];

const errorOf = (res: { json: () => unknown }): Record<string, unknown> => (res.json() as { error: Record<string, unknown> }).error;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = await connectAs('cp_app', db);
  t = await buildTestApp(db);
  classA = await insertClass(db, 'L3 Informatique A');
  classB = await insertClass(db, 'L3 Informatique B');
  const dA = await joinAs(classA, 'DELEGATE');
  delegateA = { token: dA.token, userId: dA.userId, password: dA.password };
  const dB = await joinAs(classB, 'DELEGATE');
  delegateB = { token: dB.token, userId: dB.userId };
  student1 = await joinAs(classA, 'STUDENT');
  admin = await loginAdmin(t.app, db);
});

afterAll(async () => {
  await sql.end();
  await t.close();
});

describe('GET /api/classes/:classId/members (P8)', () => {
  it('le délégué voit les membres actifs, avec email et rôle ; une demande en attente n’en fait pas partie', async () => {
    const pending = await registerStudent(t.app, classA);
    const res = await send(t.app, 'GET', `/api/classes/${classA}/members`, {}, cookieHeader(delegateA.token));
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.userId === student1.userId)).toMatchObject({
      userId: student1.userId,
      firstName: 'Awa',
      lastName: 'Diop',
      email: student1.email,
      role: 'STUDENT',
    });
    expect(typeof rows.find((r) => r.userId === student1.userId)?.joinedAt).toBe('string');
    expect(rows.find((r) => r.userId === delegateA.userId)?.role).toBe('DELEGATE');
    expect(rows.some((r) => r.userId === pending.userId)).toBe(false);
  });

  it('un membre étudiant de la classe → 403 FORBIDDEN (les emails sont visibles des délégués)', async () => {
    const res = await send(t.app, 'GET', `/api/classes/${classA}/members`, {}, cookieHeader(student1.token));
    expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'FORBIDDEN' }]);
  });

  it('un délégué d’une autre classe ou une classe inexistante → 404 identiques', async () => {
    const foreign = await send(t.app, 'GET', `/api/classes/${classA}/members`, {}, cookieHeader(delegateB.token));
    const unknown = await send(t.app, 'GET', `/api/classes/${uuidv7()}/members`, {}, cookieHeader(delegateA.token));
    expect([foreign.statusCode, errorOf(foreign)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect([unknown.statusCode, errorOf(unknown)]).toEqual([404, { code: 'NOT_FOUND' }]);
  });
});

describe('DELETE /api/classes/:classId/members/:userId (retrait, § 4.5)', () => {
  it('sans ressaisie récente du mot de passe → 403 REAUTH_REQUIRED, le membre reste en place', async () => {
    const victim = await joinAs(classA, 'STUDENT');
    const res = await send(t.app, 'DELETE', `/api/classes/${classA}/members/${victim.userId}`, {}, cookieHeader(delegateA.token));
    expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'REAUTH_REQUIRED' }]);
    const m = await membershipOf(victim.userId, classA);
    expect(m.left_at).toBeNull();
  });

  it('un délégué retire un autre délégué → 403 DELEGATE_FORBIDDEN, avant même la ressaisie', async () => {
    const other = await joinAs(classA, 'DELEGATE'); // max_delegates = 2 : c'est le second
    const res = await send(t.app, 'DELETE', `/api/classes/${classA}/members/${other.userId}`, {}, cookieHeader(delegateA.token));
    expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'DELEGATE_FORBIDDEN' }]);
    const m = await membershipOf(other.userId, classA);
    expect(m.left_at).toBeNull();
  });

  it('un membre étudiant ne retire personne → 403 FORBIDDEN', async () => {
    const victim = await joinAs(classA, 'STUDENT');
    const res = await send(t.app, 'DELETE', `/api/classes/${classA}/members/${victim.userId}`, {}, cookieHeader(student1.token));
    expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'FORBIDDEN' }]);
    expect((await membershipOf(victim.userId, classA)).left_at).toBeNull();
  });

  it('le délégué retire un étudiant avec motif : 204, clôture REMOVED, audit, aucun email', async () => {
    await reauth(cookieHeader(delegateA.token));
    const res = await send(t.app, 'DELETE', `/api/classes/${classA}/members/${student1.userId}`, { note: 'Ne vient plus en cours' }, cookieHeader(delegateA.token));
    expect(res.statusCode).toBe(204);
    const m = await membershipOf(student1.userId, classA);
    expect(m).toMatchObject({ left_reason: 'REMOVED', left_by: delegateA.userId, left_note: 'Ne vient plus en cours' });
    expect(m.left_at).not.toBeNull();
    const a = await sql.query(
      `select action, target_type, target_id, metadata from app.audit_log where action = 'MEMBER_REMOVED' and target_id = $1 order by occurred_at desc limit 1`,
      [student1.userId],
    );
    // Ni motif ni email dans l'audit (§ 2.5) : exactement les identifiants.
    expect(a.rows[0]).toEqual({ action: 'MEMBER_REMOVED', target_type: 'USER', target_id: student1.userId, metadata: { classId: classA, userId: student1.userId } });
    const mail = await sql.query(`select count(*)::int as n from app.email_outbox where recipient_user_id = $1`, [student1.userId]);
    expect(mail.rows[0].n).toBe(0); // R6 : seul le refus envoie un email
  });

  it('le membre retiré reçoit 404 sur les requêtes de la classe (§ 4.5)', async () => {
    const requests = await send(t.app, 'GET', `/api/classes/${classA}/requests`, {}, cookieHeader(student1.token));
    const members = await send(t.app, 'GET', `/api/classes/${classA}/members`, {}, cookieHeader(student1.token));
    expect([requests.statusCode, errorOf(requests)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect([members.statusCode, errorOf(members)]).toEqual([404, { code: 'NOT_FOUND' }]);
  });

  it('un membre d’une autre classe → 404 identique à un utilisateur inconnu', async () => {
    const victimB = await joinAs(classB, 'STUDENT');
    const foreign = await send(t.app, 'DELETE', `/api/classes/${classA}/members/${victimB.userId}`, {}, cookieHeader(delegateA.token));
    const unknown = await send(t.app, 'DELETE', `/api/classes/${classA}/members/${uuidv7()}`, {}, cookieHeader(delegateA.token));
    expect([foreign.statusCode, errorOf(foreign)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect([unknown.statusCode, errorOf(unknown)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect((await membershipOf(victimB.userId, classB)).left_at).toBeNull();
  });

  it('motif trop long → 400 VALIDATION_FAILED, sans effet ; sans motif → 204 et left_note vide', async () => {
    const victim = await joinAs(classA, 'STUDENT');
    const bad = await send(t.app, 'DELETE', `/api/classes/${classA}/members/${victim.userId}`, { note: 'x'.repeat(501) }, cookieHeader(delegateA.token));
    expect([bad.statusCode, errorOf(bad).code]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await membershipOf(victim.userId, classA)).left_at).toBeNull();
    const ok = await send(t.app, 'DELETE', `/api/classes/${classA}/members/${victim.userId}`, {}, cookieHeader(delegateA.token));
    expect(ok.statusCode).toBe(204);
    const m = await membershipOf(victim.userId, classA);
    expect(m.left_reason).toBe('REMOVED');
    expect(m.left_note).toBeNull();
  });

  it('l’admin retire n’importe qui, y compris un délégué', async () => {
    await reauth(admin.headers);
    const other = await sql.query(`select user_id from app.class_memberships where class_id = $1 and role = 'DELEGATE' and left_at is null and user_id <> $2`, [classA, delegateA.userId]);
    const target = other.rows[0]?.user_id as string;
    const res = await send(t.app, 'DELETE', `/api/classes/${classA}/members/${target}`, { note: 'Délégation terminée' }, admin.headers);
    expect(res.statusCode).toBe(204);
    expect(await membershipOf(target, classA)).toMatchObject({ left_reason: 'REMOVED', left_note: 'Délégation terminée' });
  });

  it('classe archivée → 409 CLASS_ARCHIVED pour le délégué, 404 pour un étranger', async () => {
    const classC = await insertClass(db, 'L3 Archivée C');
    const cDelegate = await joinAs(classC, 'DELEGATE');
    const cStudent = await joinAs(classC, 'STUDENT');
    await sql.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [classC]);
    const res = await send(t.app, 'DELETE', `/api/classes/${classC}/members/${cStudent.userId}`, {}, cookieHeader(cDelegate.token));
    expect([res.statusCode, errorOf(res)]).toEqual([409, { code: 'CLASS_ARCHIVED' }]);
    const foreign = await send(t.app, 'DELETE', `/api/classes/${classC}/members/${cStudent.userId}`, {}, cookieHeader(delegateA.token));
    expect([foreign.statusCode, errorOf(foreign)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect((await membershipOf(cStudent.userId, classC)).left_at).toBeNull();
  });
});
