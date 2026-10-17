import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { connectAs, createTestDatabase } from '../support/pg.js';
import { loginAdmin } from '../support/second-factor.js';

let db: string;
let t: TestApp;
let sql: pg.Client;
let classA: string;
let classB: string;
let admin: { headers: Record<string, string> };
let dA: { token: string; userId: string };
let sA: { token: string; userId: string };

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

const namesOf = (res: { json: () => unknown }): string[] => (res.json() as Array<{ name: string }>).map((s) => s.name);

beforeAll(async () => {
  db = await createTestDatabase();
  sql = await connectAs('cp_app', db);
  t = await buildTestApp(db);
  classA = await insertClass(db, 'L2 Physique A');
  classB = await insertClass(db, 'L2 Physique B');
  dA = await joinAs(classA, 'DELEGATE');
  sA = await joinAs(classA, 'STUDENT');
  admin = await loginAdmin(t.app, db);
  // Une matière dans B, pour les cas « 404 : matière d'une autre classe ».
  await sql.query(`insert into app.subjects (id, class_id, name) values ($1, $2, 'Histoire')`, [uuidv7(), classB]);
});

afterAll(async () => {
  await sql.end();
  await t.close();
});

describe('GET /api/classes/:classId/subjects (liste)', () => {
  it('le délégué liste les matières triées par nom', async () => {
    await send(t.app, 'POST', `/api/classes/${classA}/subjects`, { name: 'Mathématiques' }, cookieHeader(dA.token));
    await send(t.app, 'POST', `/api/classes/${classA}/subjects`, { name: 'Algorithmique' }, cookieHeader(dA.token));
    const res = await send(t.app, 'GET', `/api/classes/${classA}/subjects`, undefined, cookieHeader(dA.token));
    expect(res.statusCode).toBe(200);
    expect(namesOf(res)).toEqual(['Algorithmique', 'Mathématiques']);
  });

  it('l’admin liste les matières aussi ; un étudiant reçoit 403 FORBIDDEN', async () => {
    expect((await send(t.app, 'GET', `/api/classes/${classA}/subjects`, undefined, admin.headers)).statusCode).toBe(200);
    const res = await send(t.app, 'GET', `/api/classes/${classA}/subjects`, undefined, cookieHeader(sA.token));
    expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'FORBIDDEN' }]);
  });

  it('classe inconnue ou paramètre non-uuid → 404 identiques', async () => {
    const unknown = await send(t.app, 'GET', `/api/classes/${uuidv7()}/subjects`, undefined, admin.headers);
    const malformed = await send(t.app, 'GET', `/api/classes/:classId/subjects`, undefined, admin.headers);
    expect([unknown.statusCode, errorOf(unknown)]).toEqual([404, { code: 'NOT_FOUND' }]);
    expect([malformed.statusCode, errorOf(malformed)]).toEqual([404, { code: 'NOT_FOUND' }]);
  });
});

describe('POST /api/classes/:classId/subjects (création, R12)', () => {
  it('le délégué crée : 201, nom normalisé, audit SUBJECT_CREATED', async () => {
    const res = await send(t.app, 'POST', `/api/classes/${classA}/subjects`, { name: '   Sciences  de la Terre   ' }, cookieHeader(dA.token));
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; createdAt: string };
    expect(body.name).toBe('Sciences de la Terre');
    const a = await sql.query(
      `select action, target_type, target_id, metadata from app.audit_log where action = 'SUBJECT_CREATED' and target_id = $1`,
      [body.id],
    );
    expect(a.rows[0]).toEqual({
      action: 'SUBJECT_CREATED',
      target_type: 'SUBJECT',
      target_id: body.id,
      metadata: { classId: classA, subjectId: body.id, name: 'Sciences de la Terre' },
    });
  });

  it('l’admin crée aussi : 201', async () => {
    const res = await send(t.app, 'POST', `/api/classes/${classA}/subjects`, { name: 'Philosophie' }, admin.headers);
    expect(res.statusCode).toBe(201);
    expect((res.json() as { name: string }).name).toBe('Philosophie');
  });

  it('doublon insensible à la casse → 409 SUBJECT_ALREADY_EXISTS', async () => {
    const res = await send(t.app, 'POST', `/api/classes/${classA}/subjects`, { name: 'PHILOSOPHIE' }, cookieHeader(dA.token));
    expect([res.statusCode, errorOf(res)]).toEqual([409, { code: 'SUBJECT_ALREADY_EXISTS' }]);
  });

  it('nom hors gabarit (2–60, caractères interdits) → 400 INVALID_SUBJECT_NAME', async () => {
    // Vide ou absent : erreur structurelle du pipe (VALIDATION_FAILED) — ici, des noms valides structurellement mais non conformes.
    for (const name of ['A', 'x'.repeat(61), 'Math\u0007s', '   ']) {
      const res = await send(t.app, 'POST', `/api/classes/${classA}/subjects`, { name }, cookieHeader(dA.token));
      expect([name, res.statusCode, errorOf(res)]).toEqual([name, 400, { code: 'INVALID_SUBJECT_NAME' }]);
    }
    const empty = await send(t.app, 'POST', `/api/classes/${classA}/subjects`, { name: '' }, cookieHeader(dA.token));
    expect([empty.statusCode, errorOf(empty).code]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('un étudiant ne crée pas → 403 FORBIDDEN ; classe archivée → 409 CLASS_ARCHIVED', async () => {
    const denied = await send(t.app, 'POST', `/api/classes/${classA}/subjects`, { name: 'Musique' }, cookieHeader(sA.token));
    expect([denied.statusCode, errorOf(denied)]).toEqual([403, { code: 'FORBIDDEN' }]);
    const classC = await insertClass(db, 'L2 Archivée C');
    await sql.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [classC]);
    const archived = await send(t.app, 'POST', `/api/classes/${classC}/subjects`, { name: 'Musique' }, admin.headers);
    expect([archived.statusCode, errorOf(archived)]).toEqual([409, { code: 'CLASS_ARCHIVED' }]);
  });
});

describe('DELETE /api/classes/:classId/subjects/:subjectId (suppression)', () => {
  it('le délégué supprime une matière libre : 204, disparue, audit SUBJECT_DELETED avec le nom', async () => {
    const created = await send(t.app, 'POST', `/api/classes/${classA}/subjects`, { name: 'Éducation physique' }, cookieHeader(dA.token));
    const { id } = created.json() as { id: string };
    const res = await send(t.app, 'DELETE', `/api/classes/${classA}/subjects/${id}`, {}, cookieHeader(dA.token));
    expect(res.statusCode).toBe(204);
    const list = await send(t.app, 'GET', `/api/classes/${classA}/subjects`, undefined, cookieHeader(dA.token));
    expect(namesOf(list)).not.toContain('Éducation physique');
    const a = await sql.query(
      `select action, target_type, target_id, metadata from app.audit_log where action = 'SUBJECT_DELETED' and target_id = $1`,
      [id],
    );
    expect(a.rows[0]).toEqual({
      action: 'SUBJECT_DELETED',
      target_type: 'SUBJECT',
      target_id: id,
      metadata: { classId: classA, subjectId: id, name: 'Éducation physique' },
    });
  });

  it('l’admin supprime aussi : 204', async () => {
    const created = await send(t.app, 'POST', `/api/classes/${classA}/subjects`, { name: 'Espagnol' }, admin.headers);
    const { id } = created.json() as { id: string };
    expect((await send(t.app, 'DELETE', `/api/classes/${classA}/subjects/${id}`, {}, admin.headers)).statusCode).toBe(204);
  });

  it('matière d’une autre classe, uuid inconnu ou non-uuid → 404 identiques', async () => {
    const otherClass = (await sql.query(`select id from app.subjects where class_id = $1`, [classB])).rows[0]?.id as string;
    const foreign = await send(t.app, 'DELETE', `/api/classes/${classA}/subjects/${otherClass}`, {}, admin.headers);
    const unknown = await send(t.app, 'DELETE', `/api/classes/${classA}/subjects/${uuidv7()}`, {}, admin.headers);
    const malformed = await send(t.app, 'DELETE', `/api/classes/${classA}/subjects/pas-un-uuid`, {}, admin.headers);
    for (const res of [foreign, unknown, malformed]) expect([res.statusCode, errorOf(res)]).toEqual([404, { code: 'NOT_FOUND' }]);
  });

  it('un étudiant ne supprime pas → 403 FORBIDDEN ; classe archivée → 409 CLASS_ARCHIVED', async () => {
    await sql.query(`insert into app.subjects (id, class_id, name) values ($1, $2, 'Histoire de l’art')`, [uuidv7(), classA]);
    const kept = (await sql.query(`select id from app.subjects where class_id = $1 and name = 'Histoire de l’art'`, [classA])).rows[0]?.id as string;
    const denied = await send(t.app, 'DELETE', `/api/classes/${classA}/subjects/${kept}`, {}, cookieHeader(sA.token));
    expect([denied.statusCode, errorOf(denied)]).toEqual([403, { code: 'FORBIDDEN' }]);

    const classD = await insertClass(db, 'L2 Archivée D');
    await sql.query(`insert into app.subjects (id, class_id, name) values ($1, $2, 'Cuisine')`, [uuidv7(), classD]);
    await sql.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [classD]);
    const archived = await send(t.app, 'DELETE', `/api/classes/${classD}/subjects/${(await sql.query(`select id from app.subjects where class_id = $1`, [classD])).rows[0].id}`, {}, admin.headers);
    expect([archived.statusCode, errorOf(archived)]).toEqual([409, { code: 'CLASS_ARCHIVED' }]);
  });
});
