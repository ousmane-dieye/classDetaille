import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseReadinessProbe } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { isRetryableTxError } from '../../src/database/tx.js';
import { connectAs, createTestDatabase, dbConfigFor, runSql } from '../support/pg.js';

let db: string;
let a: PrismaService;
let b: PrismaService;

beforeAll(async () => {
  db = await createTestDatabase();
  // Table de test créée en superutilisateur : initialisation uniquement.
  await runSql(db, `create table app.dl (id int primary key, v int not null); insert into app.dl values (1,0),(2,0); grant select, update on app.dl to cp_app;`);
  a = new PrismaService(dbConfigFor('cp_app', db));
  b = new PrismaService(dbConfigFor('cp_app', db));
});
afterAll(async () => { await a.onModuleDestroy(); await b.onModuleDestroy(); });

describe('module database', () => {
  it('ping renvoie vrai sous cp_app', async () => {
    await expect(a.ping()).resolves.toBe(true);
  });

  it('les transactions sont en READ COMMITTED', async () => {
    const level = await a.withTx((tx) => tx.$queryRaw<{ l: string }[]>`select current_setting('transaction_isolation') as l`);
    expect(level[0]?.l).toBe('read committed');
  });

  it('un interblocage réel est reconnu comme rejouable', async () => {
    const barrier = Promise.withResolvers<void>();
    let seen: unknown;
    const t1 = a.client.$transaction(async (tx) => {
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 1`;
      await barrier.promise;
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 2`;
    }).catch((e) => { seen = e; });
    const t2 = b.client.$transaction(async (tx) => {
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 2`;
      barrier.resolve();
      await tx.$executeRaw`select pg_sleep(0.2)`;
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 1`;
    }).catch((e) => { seen = e; });
    await Promise.all([t1, t2]);
    expect(seen).toBeDefined();
    expect(isRetryableTxError(seen)).toBe(true);
  });

  it('withTx rejoue après un interblocage et aboutit', async () => {
    const barrier = Promise.withResolvers<void>();
    const r1 = a.withTx(async (tx) => {
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 1`;
      await barrier.promise;
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 2`;
      return 'a';
    });
    const r2 = b.withTx(async (tx) => {
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 2`;
      barrier.resolve();
      await tx.$executeRaw`select pg_sleep(0.2)`;
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 1`;
      return 'b';
    });
    await expect(Promise.all([r1, r2])).resolves.toEqual(['a', 'b']);
  });
});

describe('détection G4 : réglage log_* enregistré sur un rôle ou sur la base', () => {
  it('cp_app peut lire pg_db_role_setting (nécessaire à la détection)', async () => {
    const c = await connectAs('cp_app', db);
    try {
      const r = await c.query(`select has_table_privilege('pg_catalog.pg_db_role_setting', 'SELECT') as ok`);
      expect(r.rows[0].ok).toBe(true);
    } finally { await c.end(); }
  });

  it.each([
    ['ALTER DATABASE … SET (base courante)', (d: string) => `ALTER DATABASE ${d} SET log_min_duration_statement = 1000`, (d: string) => `ALTER DATABASE ${d} RESET log_min_duration_statement`],
    ['ALTER ROLE … IN DATABASE … SET', (d: string) => `ALTER ROLE cp_monitor IN DATABASE ${d} SET log_statement = 'none'`, (d: string) => `ALTER ROLE cp_monitor IN DATABASE ${d} RESET log_statement`],
    ['ALTER ROLE … SET (tout le serveur)', () => `ALTER ROLE cp_ops SET log_min_messages = 'warning'`, () => `ALTER ROLE cp_ops RESET log_min_messages`],
  ])('%s : sonde fausse, puis vraie après retrait', async (_label, set, reset) => {
    const probe = new DatabaseReadinessProbe(a);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(probe.check()).resolves.toBe(true);
      await runSql('postgres', set(db));
      try {
        await expect(a.hasLogSettingOverrides()).resolves.toBe(true);
        await expect(probe.check()).resolves.toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).not.toMatch(/=|1000|none|warning/);
      } finally {
        await runSql('postgres', reset(db));
      }
      await expect(probe.check()).resolves.toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('un réglage d’une autre base ou hors log_* (« _ » échappé : logical_…) ne déclenche pas la détection', async () => {
    const other = await createTestDatabase();
    try {
      await runSql('postgres', `ALTER DATABASE ${other} SET log_statement = 'none'`);
      await runSql('postgres', `ALTER DATABASE ${db} SET logical_decoding_work_mem = '64MB'`);
      await expect(a.hasLogSettingOverrides()).resolves.toBe(false);
      await expect(new DatabaseReadinessProbe(a).check()).resolves.toBe(true);
    } finally {
      await runSql('postgres', `ALTER DATABASE ${db} RESET logical_decoding_work_mem`);
      await runSql('postgres', `DROP DATABASE ${other}`);
    }
  });
});
