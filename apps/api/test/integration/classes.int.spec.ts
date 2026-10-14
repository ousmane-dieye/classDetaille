import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../src/database/prisma.service.js';
import { MembershipsService } from '../../src/modules/memberships/memberships.service.js';
import { ClassesService } from '../../src/modules/classes/classes.service.js';
import { buildTestApp, insertClass, send, type TestApp } from '../support/app.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
beforeAll(async () => {
  db = await createTestDatabase();
  await insertClass(db, 'L3 Informatique', { year: '2026-2027' });
  await insertClass(db, 'M1 Réseaux', { year: '2026-2027' });
  await insertClass(db, 'L3 Informatique', { year: '2025-2026', archived: true });
  t = await buildTestApp(db);
});
afterAll(async () => { await t.close(); });

describe('GET /api/classes/active (§ 0.6 : seules les classes actives)', () => {
  it('public, classes actives seulement, triées par année puis nom, DTO minimal', async () => {
    const res = await send(t.app, 'GET', '/api/classes/active');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; academicYear: string }[];
    expect(body.map((c) => `${c.academicYear} ${c.name}`)).toEqual(['2026-2027 L3 Informatique', '2026-2027 M1 Réseaux']);
    expect(Object.keys(body[0]!).sort()).toEqual(['academicYear', 'id', 'level', 'name']);
  });
});

describe('ClassesService.create (sous cp_app)', () => {
  const cli = { kind: 'cli', command: 'create-class' } as const;
  it('crée une classe, la liste, et refuse un doublon (409) ou une année invalide (400)', async () => {
    const svc = t.app.get(ClassesService);
    const id = await svc.create(cli, { name: 'L2 Maths', level: 'L2', academicYear: '2026-2027' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const list = await svc.listActive({ kind: 'anonymous', ip: '203.0.113.9' });
    expect(list.map((c) => c.name)).toContain('L2 Maths');
    await expect(svc.create(cli, { name: 'L2 Maths', level: 'L2', academicYear: '2026-2027' })).rejects.toMatchObject({ code: 'CLASS_ALREADY_EXISTS' });
    await expect(svc.create(cli, { name: 'L2 Maths', level: 'L2', academicYear: '2026-2028' })).rejects.toMatchObject({ code: 'INVALID_ACADEMIC_YEAR' });
    // NUL : erreur de validation propre, pas une erreur Postgres 22021.
    await expect(svc.create(cli, { name: 'L2\u0000Maths', level: 'L2', academicYear: '2026-2027' })).rejects.toMatchObject({ code: 'INVALID_CLASS_NAME' });
    await expect(svc.create(cli, { name: 'L2 Maths 2', level: 'L\u00002', academicYear: '2026-2027' })).rejects.toMatchObject({ code: 'INVALID_CLASS_LEVEL' });
  });
});

describe('MembershipsService.createRequestInTx (sous cp_app)', () => {
  it('crée une demande en attente pour une classe active', async () => {
    const userId = uuidv7();
    const c = await connectAs('cp_app', db);
    await c.query(`insert into app.users (id, email, first_name, last_name, password_hash) values ($1, $2, 'Awa', 'Diop', 'x')`, [userId, `${userId}@example.com`]);
    await c.end();
    const classId = await insertClass(db, 'L1 Droit');
    const anon = { kind: 'anonymous', ip: '203.0.113.9' } as const;
    const m = t.app.get(MembershipsService);
    const prisma = t.app.get(PrismaService);
    await prisma.withTx((tx) => m.createRequestInTx(tx, anon, { userId, classId }));
    const o = await connectAs('cp_owner', db);
    const r = await o.query(`select status from app.enrollment_requests where user_id = $1`, [userId]);
    await o.end();
    expect(r.rows).toEqual([{ status: 'PENDING' }]);
  });
});
