import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { connectAs, createTestDatabase } from '../support/pg.js';
import { ageChallenges, latestCode, loginAdmin } from '../support/second-factor.js';

let db: string;
let t: TestApp;
let sql: pg.Client;
let classA: string; // classe source (ancienne année)
let classB: string; // classe destination (nouvelle année)
let classC: string; // autre classe
let admin: { id: string; email: string; password: string };
let adminHeaders: Record<string, string>;
let s1: { token: string; userId: string };
let s2: { token: string; userId: string };
let d1: { token: string; userId: string };
let s3: { token: string; userId: string };
let s4: { token: string; userId: string };
let p1: { token: string; userId: string }; // demande en attente : aucune appartenance

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

const errorOf = (res: { json: () => unknown }): Record<string, unknown> => (res.json() as { error: Record<string, unknown> }).error;

async function roleOf(userId: string, classId: string): Promise<string | null> {
  const r = await sql.query(`select role from app.class_memberships where user_id = $1 and class_id = $2 and left_at is null`, [userId, classId]);
  return (r.rows[0]?.role as string | undefined) ?? null;
}

async function closureOf(userId: string, classId: string): Promise<Record<string, unknown> | undefined> {
  const r = await sql.query(`select left_reason, left_by from app.class_memberships where user_id = $1 and class_id = $2 and left_at is not null`, [userId, classId]);
  return r.rows[0];
}

/** Vérification supplémentaire complète (M13) : mot de passe puis code. */
async function completeStepUp(): Promise<void> {
  await ageChallenges(db, admin.id, 2);
  expect((await send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, adminHeaders)).statusCode).toBe(202);
  const code = await latestCode(db, admin.email);
  expect((await send(t.app, 'POST', '/api/me/step-up/verify', { code }, adminHeaders)).statusCode).toBe(204);
}

beforeAll(async () => {
  db = await createTestDatabase();
  sql = await connectAs('cp_app', db);
  t = await buildTestApp(db);
  classA = await insertClass(db, 'L3 Avant A');
  classB = await insertClass(db, 'L3 Apres B');
  classC = await insertClass(db, 'L3 Autre C');
  s1 = await joinAs(classA, 'STUDENT');
  s2 = await joinAs(classA, 'STUDENT');
  d1 = await joinAs(classA, 'DELEGATE');
  s3 = await joinAs(classB, 'STUDENT');
  s4 = await joinAs(classC, 'STUDENT');
  p1 = await registerStudent(t.app, classC); // jamais acceptée : aucune appartenance
  const l = await loginAdmin(t.app, db);
  admin = l.admin;
  adminHeaders = l.headers;
});

afterAll(async () => {
  await sql.end();
  await t.close();
});

describe('POST /api/users/:userId/transfer (transfert simple, R7)', () => {
  it('un étudiant → 403 FORBIDDEN ; sans ressaisie récente → 403 REAUTH_REQUIRED ; userId non-uuid → 404', async () => {
    const denied = await send(t.app, 'POST', `/api/users/${s2.userId}/transfer`, { toClassId: classB }, cookieHeader(s1.token));
    expect([denied.statusCode, errorOf(denied)]).toEqual([403, { code: 'FORBIDDEN' }]);
    const noReauth = await send(t.app, 'POST', `/api/users/${s2.userId}/transfer`, { toClassId: classB }, adminHeaders);
    expect([noReauth.statusCode, errorOf(noReauth)]).toEqual([403, { code: 'REAUTH_REQUIRED' }]);
    const malformed = await send(t.app, 'POST', `/api/users/pas-un-uuid/transfer`, { toClassId: classB }, adminHeaders);
    expect([malformed.statusCode, errorOf(malformed)]).toEqual([404, { code: 'NOT_FOUND' }]);
  });

  it("transfert d'un étudiant : ancienne clôturée TRANSFER, nouvelle STUDENT, ancienne classe → 404, audit", async () => {
    expect((await send(t.app, 'POST', '/api/me/reauth', { password: admin.password }, adminHeaders)).statusCode).toBe(204);
    const res = await send(t.app, 'POST', `/api/users/${s1.userId}/transfer`, { toClassId: classB }, adminHeaders);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: s1.userId, toClassId: classB });
    expect(await closureOf(s1.userId, classA)).toEqual({ left_reason: 'TRANSFER', left_by: admin.id });
    expect(await roleOf(s1.userId, classB)).toBe('STUDENT');
    const oldClass = await send(t.app, 'GET', `/api/classes/${classA}`, undefined, cookieHeader(s1.token));
    expect([oldClass.statusCode, errorOf(oldClass)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect((await send(t.app, 'GET', `/api/classes/${classB}`, undefined, cookieHeader(s1.token))).statusCode).toBe(200);
    const a = await sql.query(`select action, target_type, target_id, metadata from app.audit_log where action = 'MEMBER_TRANSFERRED' and target_id = $1`, [s1.userId]);
    expect(a.rows[0]).toEqual({
      action: 'MEMBER_TRANSFERRED',
      target_type: 'USER',
      target_id: s1.userId,
      metadata: { userId: s1.userId, fromClassId: classA, toClassId: classB },
    });
  });

  it("transfert d'un délégué : il redevient STUDENT", async () => {
    const res = await send(t.app, 'POST', `/api/users/${d1.userId}/transfer`, { toClassId: classC }, adminHeaders);
    expect(res.statusCode).toBe(200);
    expect(await roleOf(d1.userId, classC)).toBe('STUDENT');
  });

  it('cible archivée → 409 ; cible inconnue → 404 ; cible non-uuid → 400 ; personne sans appartenance → 404', async () => {
    const archived = await insertClass(db, 'L3 Archivee E');
    await sql.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [archived]);
    const toArchived = await send(t.app, 'POST', `/api/users/${s2.userId}/transfer`, { toClassId: archived }, adminHeaders);
    expect([toArchived.statusCode, errorOf(toArchived)]).toEqual([409, { code: 'CLASS_ARCHIVED' }]);
    const unknownClass = await send(t.app, 'POST', `/api/users/${s2.userId}/transfer`, { toClassId: uuidv7() }, adminHeaders);
    expect([unknownClass.statusCode, errorOf(unknownClass)]).toEqual([404, { code: 'NOT_FOUND' }]);
    const malformedClass = await send(t.app, 'POST', `/api/users/${s2.userId}/transfer`, { toClassId: 'pas-un-uuid' }, adminHeaders);
    expect([malformedClass.statusCode, errorOf(malformedClass).code]).toEqual([400, 'VALIDATION_FAILED']);
    const noMembership = await send(t.app, 'POST', `/api/users/${p1.userId}/transfer`, { toClassId: classB }, adminHeaders);
    expect([noMembership.statusCode, errorOf(noMembership)]).toEqual([404, { code: 'NOT_FOUND' }]);
    const unknownUser = await send(t.app, 'POST', `/api/users/${uuidv7()}/transfer`, { toClassId: classB }, adminHeaders);
    expect([unknownUser.statusCode, errorOf(unknownUser)]).toEqual([404, { code: 'NOT_FOUND' }]);
  });
});

describe('POST /api/classes/:classId/transfers (transfert en masse, R7)', () => {
  it('un étudiant → 403 FORBIDDEN ; sans vérification complète → 403 STEP_UP_REQUIRED', async () => {
    const denied = await send(t.app, 'POST', `/api/classes/${classB}/transfers`, { userIds: [s2.userId] }, cookieHeader(s1.token));
    expect([denied.statusCode, errorOf(denied)]).toEqual([403, { code: 'FORBIDDEN' }]);
    // Le bloc précédent a ressaisi le mot de passe : sans remise à zéro, seule la partie code manquerait.
    await sql.query(`update app.sessions set reauth_at = null, step_up_at = null where user_id = $1`, [admin.id]);
    const noStepUp = await send(t.app, 'POST', `/api/classes/${classB}/transfers`, { userIds: [s2.userId] }, adminHeaders);
    expect([noStepUp.statusCode, errorOf(noStepUp)]).toMatchObject([403, { code: 'STEP_UP_REQUIRED', missing: 'PASSWORD' }]);
  });

  it('avec la vérification complète : 200 { transferred }, tous STUDENT (délégué non reconduit), audit par étudiant', async () => {
    // Un délégué dans le lot : il n'est pas reconduit (R7). Un compte réel, sinon le déclencheur refuse.
    const d2 = (await joinAs(classA, 'DELEGATE')).userId;
    await completeStepUp();
    const batch = [s2.userId, s4.userId, d2];
    const sourceOf = new Map([[s2.userId, classA], [s4.userId, classC], [d2, classA]]);
    const res = await send(t.app, 'POST', `/api/classes/${classB}/transfers`, { userIds: batch }, adminHeaders);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transferred: 3 });
    for (const userId of batch) {
      expect(await roleOf(userId, classB)).toBe('STUDENT');
      expect(await closureOf(userId, sourceOf.get(userId) ?? '')).toMatchObject({ left_reason: 'TRANSFER', left_by: admin.id });
    }
    const audits = await sql.query(`select target_id, metadata from app.audit_log where action = 'MEMBER_TRANSFERRED' and target_id = any($1::uuid[]) order by target_id`, [batch]);
    expect(audits.rows).toHaveLength(3);
    expect(audits.rows.map((r: { target_id: string }) => r.target_id).sort()).toEqual([...batch].sort());
    for (const row of audits.rows as Array<{ target_id: string; metadata: Record<string, unknown> }>) {
      expect(row.metadata).toEqual({ userId: row.target_id, fromClassId: expect.any(String), toClassId: classB });
    }
  });

  it('atomique : une cible sans appartenance active annule tout → 404, rien ne bouge', async () => {
    const s5 = await joinAs(classC, 'STUDENT');
    const res = await send(t.app, 'POST', `/api/classes/${classB}/transfers`, { userIds: [s5.userId, p1.userId] }, adminHeaders);
    expect([res.statusCode, errorOf(res)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect(await roleOf(s5.userId, classC)).toBe('STUDENT');
    const audits = await sql.query(`select count(*)::int as n from app.audit_log where action = 'MEMBER_TRANSFERRED' and target_id = $1`, [s5.userId]);
    expect(audits.rows[0]?.n).toBe(0);
  });

  it('201 userIds → 400 BATCH_TOO_LARGE ; 200 userIds → 200 { transferred: 200 }', async () => {
    const tooMany = Array.from({ length: 201 }, () => uuidv7());
    const big = await send(t.app, 'POST', `/api/classes/${classB}/transfers`, { userIds: tooMany }, adminHeaders);
    expect([big.statusCode, errorOf(big)]).toEqual([400, { code: 'BATCH_TOO_LARGE' }]);

    const classF = await insertClass(db, 'L3 Masse F');
    const classG = await insertClass(db, 'L3 Masse G');
    await sql.query(
      `insert into app.users (id, email, first_name, last_name, password_hash)
         select gen_random_uuid(), 't7masse' || g || '@example.com', 'Lot', 'Masse', 'x' from generate_series(1, 200) g`,
    );
    await sql.query(
      `insert into app.class_memberships (id, user_id, class_id, role)
         select gen_random_uuid(), u.id, $1, 'STUDENT' from app.users u where u.email like 't7masse%@example.com'`,
      [classF],
    );
    const ids = ((await sql.query(`select u.id from app.users u where u.email like 't7masse%@example.com' order by u.id`)).rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toHaveLength(200);
    await completeStepUp();
    const res = await send(t.app, 'POST', `/api/classes/${classG}/transfers`, { userIds: ids }, adminHeaders);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transferred: 200 });
    const inG = await sql.query(`select count(*)::int as n from app.class_memberships where class_id = $1 and left_at is null`, [classG]);
    expect(inG.rows[0]?.n).toBe(200);
  });

  it('vers classe archivée → 409 ; déjà membre de la destination → 404 ; userIds vides → 400', async () => {
    const archived = (await sql.query(`select id from app.classes where name = 'L3 Archivee E'`)).rows[0]?.id as string;
    const toArchived = await send(t.app, 'POST', `/api/classes/${archived}/transfers`, { userIds: [s3.userId] }, adminHeaders);
    expect([toArchived.statusCode, errorOf(toArchived)]).toEqual([409, { code: 'CLASS_ARCHIVED' }]);
    const already = await send(t.app, 'POST', `/api/classes/${classB}/transfers`, { userIds: [s3.userId] }, adminHeaders);
    expect([already.statusCode, errorOf(already)]).toEqual([404, { code: 'NOT_FOUND' }]);
    const empty = await send(t.app, 'POST', `/api/classes/${classB}/transfers`, { userIds: [] }, adminHeaders);
    expect([empty.statusCode, errorOf(empty).code]).toEqual([400, 'VALIDATION_FAILED']);
  });
});
