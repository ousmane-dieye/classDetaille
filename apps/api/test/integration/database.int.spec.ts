import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { isRetryableTxError } from '../../src/database/tx.js';
import { createTestDatabase, dbConfigFor, runSql } from '../support/pg.js';

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
