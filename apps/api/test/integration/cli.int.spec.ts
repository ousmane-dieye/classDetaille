import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../src/database/prisma.service.js';
import { AuditRepository } from '../../src/modules/audit/audit.repository.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { AuthzService } from '../../src/modules/authz/authz.service.js';
import { CommonPasswords } from '../../src/modules/users/common-passwords.js';
import { PasswordHasher } from '../../src/modules/users/password-hasher.js';
import { UsersRepository } from '../../src/modules/users/users.repository.js';
import { UsersService } from '../../src/modules/users/users.service.js';
import { query, runCli } from '../support/app.js';
import { connectAs, createTestDatabase, dbConfigFor } from '../support/pg.js';

const ADMIN_PASSWORD = 'mot de passe administrateur solide';

function insertUser(db: string, email: string) {
  return query(db, `insert into app.users (id, email, first_name, last_name, password_hash, global_role, status, created_at, updated_at)
    values ($1::uuid, $2::ext.citext, 'Awa', 'Sow', 'x', 'USER'::app.global_role, 'ACTIVE'::app.user_status, now(), now())`, [uuidv7(), email]);
}

function makeUsers(prisma: PrismaService) {
  return new UsersService(new UsersRepository(prisma), new AuthzService(), new AuditService(new AuditRepository()), new PasswordHasher(), new CommonPasswords([]), prisma);
}

describe('create-admin (§ 3.2)', () => {
  let db: string;
  beforeAll(async () => { db = await createTestDatabase(); });

  it('crée le premier administrateur ; le mot de passe n’apparaît nulle part', async () => {
    const r = await runCli(db, ['create-admin', '--email', ' Admin@Example.com ', '--first-name', 'Moussa', '--last-name', 'Faye'], `${ADMIN_PASSWORD}\n`);
    expect(r).toMatchObject({ code: 0, stdout: 'administrateur créé\n' });
    expect(r.stdout + r.stderr).not.toContain(ADMIN_PASSWORD);
    const u = await query(db, `select email::text, global_role, status from app.users where global_role = 'ADMIN'`);
    expect(u.rows).toEqual([{ email: 'admin@example.com', global_role: 'ADMIN', status: 'ACTIVE' }]);
    expect((await query(db, `select count(*)::int as n from app.audit_log where action = 'ADMIN_CREATED'`)).rows[0].n).toBe(1);
  });
  it('refusée s’il existe déjà un administrateur actif', async () => {
    const r = await runCli(db, ['create-admin', '--email', 'second@example.com', '--first-name', 'Awa', '--last-name', 'Sow'], `${ADMIN_PASSWORD}\n`);
    expect(r).toMatchObject({ code: 1, stderr: 'erreur : ADMIN_ALREADY_EXISTS\n' });
  });
  it('mot de passe administrateur de 15 caractères → PASSWORD_TOO_SHORT ; argument manquant → INVALID_ARGUMENTS ; commande inconnue → 2', async () => {
    const fresh = await createTestDatabase();
    expect((await runCli(fresh, ['create-admin', '--email', 'a@example.com', '--first-name', 'Awa', '--last-name', 'Sow'], `${'a'.repeat(15)}\n`)).stderr).toBe('erreur : PASSWORD_TOO_SHORT\n');
    expect((await runCli(fresh, ['create-admin', '--email', 'a@example.com'], `${ADMIN_PASSWORD}\n`)).stderr).toBe('erreur : INVALID_ARGUMENTS\n');
    expect((await runCli(fresh, ['drop-everything'])).code).toBe(2);
  });
  it('adresse déjà utilisée par un compte non administrateur → EMAIL_TAKEN lisible, code 1, aucun administrateur créé', async () => {
    const fresh = await createTestDatabase();
    await insertUser(fresh, 'awa@example.com');
    const r = await runCli(fresh, ['create-admin', '--email', 'awa@example.com', '--first-name', 'Awa', '--last-name', 'Sow'], `${ADMIN_PASSWORD}\n`);
    expect(r).toMatchObject({ code: 1, stderr: 'erreur : EMAIL_TAKEN\n' });
    expect((await query(fresh, `select count(*)::int as n from app.users where global_role = 'ADMIN'`)).rows[0].n).toBe(0);
  });
});

describe('create-admin : EMAIL_TAKEN au niveau du service', () => {
  let db: string;
  let prisma: PrismaService;
  beforeAll(async () => { db = await createTestDatabase(); prisma = new PrismaService(dbConfigFor('cp_app', db)); });
  afterAll(async () => { await prisma.onModuleDestroy(); });

  it('ApiError 409 EMAIL_TAKEN, pas l’erreur brute de la base', async () => {
    await insertUser(db, 'pris@example.com');
    await expect(makeUsers(prisma).createFirstAdmin({ kind: 'cli', command: 'create-admin' }, { email: 'pris@example.com', firstName: 'Awa', lastName: 'Sow', password: ADMIN_PASSWORD }))
      .rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });
});

describe('create-admin : concurrence sérialisée par role_guard (§ 5.4)', () => {
  // D5 : les deux ordres de lancement donnent exactement un administrateur et un refus propre, sans plantage.
  it.each([['a puis b', ['a', 'b']], ['b puis a', ['b', 'a']]] as const)('%s : une attente de verrou est observée, puis un seul administrateur est créé', async (_label, order) => {
    const db = await createTestDatabase();
    const prisma = new PrismaService(dbConfigFor('cp_app', db));
    const users = makeUsers(prisma);
    try {
      const holder = await connectAs('cp_app', db);
      // Observateur : pg_stat_activity n'expose pas les attentes des autres sessions à cp_app (même schéma qu'auth-register).
      const observer = await connectAs('postgres', db);
      const holderPid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      await holder.query('begin');
      await holder.query('select id from app.role_guard where id = 1 for update');
      const cli = { kind: 'cli', command: 'create-admin' } as const;
      const inputs = {
        a: { email: 'a@example.com', firstName: 'Awa', lastName: 'Sow', password: ADMIN_PASSWORD },
        b: { email: 'b@example.com', firstName: 'Binta', lastName: 'Ba', password: ADMIN_PASSWORD },
      };
      const results = order.map((k) => users.createFirstAdmin(cli, inputs[k]).then(() => 'ok', (e: { code?: string }) => e.code ?? 'CRASH'));
      // Preuve de la concurrence : au moins une session cp_app attend le verrou de role_guard.
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        const r = await observer.query(`select count(*)::int as n from pg_stat_activity where datname = $1 and usename = 'cp_app' and pid <> $2 and wait_event_type = 'Lock'`, [db, holderPid]);
        waiting = r.rows[0].n;
        if (waiting === 0) await new Promise((res) => setTimeout(res, 50));
      }
      await holder.query('commit');
      await holder.end();
      await observer.end();
      expect(waiting).toBeGreaterThan(0);
      expect((await Promise.all(results)).sort()).toEqual(['ADMIN_ALREADY_EXISTS', 'ok']);
      expect((await query(db, `select count(*)::int as n from app.users where global_role = 'ADMIN'`)).rows[0].n).toBe(1);
    } finally {
      await prisma.onModuleDestroy();
    }
  });
});

describe('create-class (R8)', () => {
  let db: string;
  beforeAll(async () => { db = await createTestDatabase(); });

  it('crée une classe active, journalisée ; doublon → CLASS_ALREADY_EXISTS ; année invalide → INVALID_ACADEMIC_YEAR', async () => {
    const ok = await runCli(db, ['create-class', '--name', 'L3 Informatique', '--level', 'L3', '--year', '2026-2027']);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^classe créée : [0-9a-f-]{36}\n$/);
    expect((await query(db, `select status from app.classes where name = 'L3 Informatique'`)).rows).toEqual([{ status: 'ACTIVE' }]);
    expect((await query(db, `select count(*)::int as n from app.audit_log where action = 'CLASS_CREATED'`)).rows[0].n).toBe(1);
    expect((await runCli(db, ['create-class', '--name', 'L3 Informatique', '--level', 'L3', '--year', '2026-2027'])).stderr).toBe('erreur : CLASS_ALREADY_EXISTS\n');
    expect((await runCli(db, ['create-class', '--name', 'M1', '--level', 'M1', '--year', '2026-2028'])).stderr).toBe('erreur : INVALID_ACADEMIC_YEAR\n');
  });
});
