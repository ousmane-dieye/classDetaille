import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { connectAs, createTestDatabase } from '../support/pg.js';
import { ageChallenges, latestCode, loginAdmin } from '../support/second-factor.js';

let db: string;
let t: TestApp;
let sql: pg.Client;
let classA: string;
let classB: string;
let admin: { id: string; email: string; password: string };
let adminHeaders: Record<string, string>;
let dA: { token: string; userId: string };
let sA: { token: string; userId: string };
let sB: { token: string; userId: string };

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
  classA = await insertClass(db, 'L3 Informatique A');
  classB = await insertClass(db, 'L3 Informatique B');
  dA = await joinAs(classA, 'DELEGATE');
  sA = await joinAs(classA, 'STUDENT');
  sB = await joinAs(classB, 'STUDENT');
  const l = await loginAdmin(t.app, db);
  admin = l.admin;
  adminHeaders = l.headers;
});

afterAll(async () => {
  await sql.end();
  await t.close();
});

describe('GET /api/classes (liste admin)', () => {
  it('l’admin liste toutes les classes, archivées incluses, avec statut et effectif', async () => {
    const classC = await insertClass(db, 'L3 Ancienne C');
    await sql.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [classC]);
    const res = await send(t.app, 'GET', '/api/classes', undefined, adminHeaders);
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.id === classA)).toMatchObject({ name: 'L3 Informatique A', level: 'L3', academicYear: '2026-2027', status: 'ACTIVE', membersCount: 2 });
    expect(rows.find((r) => r.id === classC)).toMatchObject({ status: 'ARCHIVED' });
  });

  it('un délégué ou un étudiant reçoit 403 FORBIDDEN', async () => {
    for (const headers of [cookieHeader(dA.token), cookieHeader(sA.token)]) {
      const res = await send(t.app, 'GET', '/api/classes', undefined, headers);
      expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'FORBIDDEN' }]);
    }
  });
});

describe('POST /api/classes (création in-app)', () => {
  it('l’admin crée une classe : 201, nom normalisé, audit CLASS_CREATED via app', async () => {
    const res = await send(t.app, 'POST', '/api/classes', { name: '  L2   Réseaux ', level: 'L2', academicYear: '2026-2027' }, adminHeaders);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; status: string };
    expect(body).toMatchObject({ name: 'L2 Réseaux', status: 'ACTIVE' });
    const a = await sql.query(`select action, target_type, target_id, metadata from app.audit_log where action = 'CLASS_CREATED' and target_id = $1`, [body.id]);
    expect(a.rows[0]).toEqual({ action: 'CLASS_CREATED', target_type: 'CLASS', target_id: body.id, metadata: { via: 'app' } });
  });

  it('doublon (même nom, même année) → 409 CLASS_ALREADY_EXISTS', async () => {
    const res = await send(t.app, 'POST', '/api/classes', { name: 'L2 Réseaux', level: 'L2', academicYear: '2026-2027' }, adminHeaders);
    expect([res.statusCode, errorOf(res)]).toEqual([409, { code: 'CLASS_ALREADY_EXISTS' }]);
  });

  it('mêmes validités que la CLI → 400 INVALID_CLASS_NAME | INVALID_CLASS_LEVEL | INVALID_ACADEMIC_YEAR', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: 'A', level: 'L1', academicYear: '2026-2027' }, 'INVALID_CLASS_NAME'],
      [{ name: 'L1', level: 'x'.repeat(41), academicYear: '2026-2027' }, 'INVALID_CLASS_LEVEL'],
      [{ name: 'L1', level: 'L1', academicYear: '2026-2028' }, 'INVALID_ACADEMIC_YEAR'],
      [{ name: 'L1', level: 'L1', academicYear: 'abcd-abce' }, 'INVALID_ACADEMIC_YEAR'],
    ];
    for (const [body, code] of cases) {
      const res = await send(t.app, 'POST', '/api/classes', body, adminHeaders);
      expect([body, res.statusCode, errorOf(res).code]).toEqual([body, 400, code]);
    }
  });

  it('un délégué ne crée pas → 403 FORBIDDEN', async () => {
    const res = await send(t.app, 'POST', '/api/classes', { name: 'L9 Interdit', level: 'L9', academicYear: '2026-2027' }, cookieHeader(dA.token));
    expect([res.statusCode, errorOf(res)]).toEqual([403, { code: 'FORBIDDEN' }]);
  });
});

describe('GET /api/classes/:classId (fiche + statistiques R11)', () => {
  beforeAll(async () => {
    // Une demande en attente, une acceptée (membre), une refusée : les trois comptes des statistiques.
    await registerStudent(t.app, classA);
    const accepted = await registerStudent(t.app, classA);
    await acceptAndJoin(accepted.userId, classA, 'STUDENT');
    const refused = await registerStudent(t.app, classA);
    await sql.query(`update app.enrollment_requests set status = 'REFUSED', decided_at = now(), decided_by = $2 where user_id = $1 and class_id = $3`, [refused.userId, admin.id, classA]);
  });

  it('un membre lit la fiche avec les statistiques (membres, attentes, traitées)', async () => {
    const res = await send(t.app, 'GET', `/api/classes/${classA}`, undefined, cookieHeader(sA.token));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: classA,
      name: 'L3 Informatique A',
      status: 'ACTIVE',
      stats: { members: 3, pendingRequests: 1, decidedRequests: 4 },
    });
  });

  it('l’admin lit aussi (même sans membre) ; un étranger, un uuid inconnu ou non-uuid → 404 identiques', async () => {
    expect((await send(t.app, 'GET', `/api/classes/${classA}`, undefined, adminHeaders)).statusCode).toBe(200);
    const foreign = await send(t.app, 'GET', `/api/classes/${classA}`, undefined, cookieHeader(sB.token));
    const unknown = await send(t.app, 'GET', `/api/classes/${uuidv7()}`, undefined, adminHeaders);
    const malformed = await send(t.app, 'GET', `/api/classes/:classId`, undefined, adminHeaders);
    for (const res of [foreign, unknown, malformed]) expect([res.statusCode, errorOf(res)]).toEqual([404, { code: 'NOT_FOUND' }]);
  });
});

describe('POST /api/classes/:classId/archive (vérifiée, M13)', () => {
  let dD: { token: string; userId: string };

  it('un délégué ou un étudiant → 403 FORBIDDEN ; sans vérification complète → 403 STEP_UP_REQUIRED', async () => {
    const classD = await insertClass(db, 'L3 À archiver D');
    const denied = await send(t.app, 'POST', `/api/classes/${classD}/archive`, {}, cookieHeader(dA.token));
    expect([denied.statusCode, errorOf(denied)]).toEqual([403, { code: 'FORBIDDEN' }]);
    const noStepUp = await send(t.app, 'POST', `/api/classes/${classD}/archive`, {}, adminHeaders);
    expect([noStepUp.statusCode, errorOf(noStepUp)]).toMatchObject([403, { code: 'STEP_UP_REQUIRED', missing: 'PASSWORD' }]);
  });

  it('avec la vérification complète : 200, toutes les appartenances clôturées CLASS_ARCHIVED, audit', async () => {
    const classD = (await sql.query(`select id from app.classes where name = 'L3 À archiver D'`)).rows[0]?.id as string;
    dD = await joinAs(classD, 'DELEGATE');
    await joinAs(classD, 'STUDENT');
    await completeStepUp();
    const res = await send(t.app, 'POST', `/api/classes/${classD}/archive`, {}, adminHeaders);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: classD, status: 'ARCHIVED' });
    const closed = await sql.query(
      `select count(*)::int as n, count(*) filter (where left_reason = 'CLASS_ARCHIVED' and left_by = $2 and left_at is not null)::int as ok
         from app.class_memberships where class_id = $1 and left_at is not null`,
      [classD, admin.id],
    );
    expect(closed.rows[0]).toEqual({ n: 2, ok: 2 });
    const active = await sql.query(`select count(*)::int as n from app.class_memberships where class_id = $1 and left_at is null`, [classD]);
    expect(active.rows[0]?.n).toBe(0);
    const a = await sql.query(`select action, target_type, target_id, metadata from app.audit_log where action = 'CLASS_ARCHIVED' and target_id = $1`, [classD]);
    expect(a.rows[0]).toEqual({ action: 'CLASS_ARCHIVED', target_type: 'CLASS', target_id: classD, metadata: { classId: classD } });
  });

  it('après archivage : écriture refusée 409, ex-membres 404, admin garde la lecture, double archivage 409', async () => {
    const classD = (await sql.query(`select id from app.classes where name = 'L3 À archiver D'`)).rows[0]?.id as string;
    const write = await send(t.app, 'POST', `/api/classes/${classD}/subjects`, { name: 'Maths' }, adminHeaders);
    expect([write.statusCode, errorOf(write)]).toEqual([409, { code: 'CLASS_ARCHIVED' }]);
    const exMember = await send(t.app, 'GET', `/api/classes/${classD}`, undefined, cookieHeader(dD.token));
    expect([exMember.statusCode, errorOf(exMember)]).toEqual([404, { code: 'NOT_FOUND' }]);
    const read = await send(t.app, 'GET', `/api/classes/${classD}`, undefined, adminHeaders);
    expect(read.statusCode).toBe(200);
    expect((read.json() as { status: string }).status).toBe('ARCHIVED');
    const twice = await send(t.app, 'POST', `/api/classes/${classD}/archive`, {}, adminHeaders);
    expect([twice.statusCode, errorOf(twice)]).toEqual([409, { code: 'CLASS_ARCHIVED' }]);
  });

  it('classe inconnue ou non-uuid → 404 identiques', async () => {
    const unknown = await send(t.app, 'POST', `/api/classes/${uuidv7()}/archive`, {}, adminHeaders);
    const malformed = await send(t.app, 'POST', `/api/classes/:classId/archive`, {}, adminHeaders);
    for (const res of [unknown, malformed]) expect([res.statusCode, errorOf(res)]).toEqual([404, { code: 'NOT_FOUND' }]);
  });
});
