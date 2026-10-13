import { describe, expect, it } from 'vitest';
import { findInvalidIndexes } from '../../src/database/catalog-checks.js';
import { connectAs, createTestDatabase, dbConfigFor, runSql } from '../support/pg.js';
import { makeScratchPrismaProject, runPrisma, writeMigration } from '../support/prisma-cli.js';

async function tableExists(db: string, name: string): Promise<boolean> {
  const c = await connectAs('cp_owner', db);
  const r = await c.query(`select to_regclass($1) is not null as e`, [`app.${name}`]);
  await c.end();
  return r.rows[0].e;
}

describe('T-01 — Prisma 7.10.0', () => {
  it('T1a : migration avec BEGIN/COMMIT explicites en échec → aucune table créée', async () => {
    const db = await createTestDatabase();
    const cfg = makeScratchPrismaProject({
      '20990101000000_t1a': `-- classification: expand\nBEGIN;\nCREATE TABLE app.t1a (id int);\nSELECT 1/0;\nCOMMIT;\n`,
    });
    const r = await runPrisma(['migrate', 'deploy'], dbConfigFor('cp_owner', db), { configPath: cfg });
    expect(r.code).not.toBe(0);
    expect(await tableExists(db, 't1a')).toBe(false);
  });

  it('T1b : même migration sans BEGIN/COMMIT → comportement constaté (caractérisation)', async () => {
    const db = await createTestDatabase();
    const cfg = makeScratchPrismaProject({
      '20990101000000_t1b': `-- classification: expand\nCREATE TABLE app.t1b (id int);\nSELECT 1/0;\n`,
    });
    const r = await runPrisma(['migrate', 'deploy'], dbConfigFor('cp_owner', db), { configPath: cfg });
    expect({ failed: r.code !== 0, tableLeftBehind: await tableExists(db, 't1b') }).toMatchSnapshot();
  });

  it('T2 : deux deploy simultanés → une seule application, verrou observé', async () => {
    const db = await createTestDatabase();
    const cfg = makeScratchPrismaProject({
      '20990101000000_t2': `-- classification: expand\nBEGIN;\nSELECT pg_sleep(4);\nCREATE TABLE app.t2 (id int);\nCOMMIT;\n`,
    });
    const owner = dbConfigFor('cp_owner', db);
    const p1 = runPrisma(['migrate', 'deploy'], owner, { configPath: cfg });
    const p2 = runPrisma(['migrate', 'deploy'], owner, { configPath: cfg });
    let settled = false;
    const both = Promise.all([p1, p2]).finally(() => { settled = true; });
    const mon = await connectAs('postgres', db);
    let advisoryWaitSeen = false;
    // Sonde jusqu'à la fin des deux processus (le démarrage de la CLI Prisma prend plusieurs secondes).
    for (let i = 0; i < 600 && !advisoryWaitSeen && !settled; i++) {
      const w = await mon.query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
      advisoryWaitSeen = w.rows[0].n > 0;
      await new Promise((res) => setTimeout(res, 200));
    }
    await mon.end();
    const [r1, r2] = await both;
    expect([r1.code, r2.code]).toEqual([0, 0]);
    expect(advisoryWaitSeen).toBe(true);
    const c = await connectAs('cp_owner', db);
    const n = await c.query(`select count(*)::int as n from app._prisma_migrations where migration_name = '20990101000000_t2'`);
    await c.end();
    expect(n.rows[0].n).toBe(1);
  });

  it('T3 : resolve --rolled-back après un échec, correction, puis deploy réussi', async () => {
    const db = await createTestDatabase();
    const owner = dbConfigFor('cp_owner', db);
    const name = '20990101000000_t3';
    const cfg = makeScratchPrismaProject({ [name]: `-- classification: expand\nBEGIN;\nCREATE TABLE app.t3 (id int);\nSELECT 1/0;\nCOMMIT;\n` });
    expect((await runPrisma(['migrate', 'deploy'], owner, { configPath: cfg })).code).not.toBe(0);
    expect((await runPrisma(['migrate', 'resolve', '--rolled-back', name], owner, { configPath: cfg })).code).toBe(0);
    writeMigration(cfg, name, `-- classification: expand\nBEGIN;\nCREATE TABLE app.t3 (id int);\nCOMMIT;\n`);
    expect((await runPrisma(['migrate', 'deploy'], owner, { configPath: cfg })).code).toBe(0);
    expect(await tableExists(db, 't3')).toBe(true);
  });

  it('T4 : index CONCURRENTLY interrompu → index invalide détecté par le contrôle de catalogue', async () => {
    const db = await createTestDatabase();
    await runSql(db, `create table app.big (id bigint, v text); insert into app.big select g, md5(g::text) from generate_series(1, 3000000) g; alter table app.big owner to cp_owner;`);
    const cfg = makeScratchPrismaProject({
      '20990101000000_t4': `-- classification: expand\nCREATE INDEX CONCURRENTLY big_v_idx ON app.big (v);\n`,
    });
    const deploy = runPrisma(['migrate', 'deploy'], dbConfigFor('cp_owner', db), { configPath: cfg });
    let settled = false;
    const done = deploy.finally(() => { settled = true; });
    const su = await connectAs('postgres', db);
    let killed = false;
    // Sonde jusqu'à la fin du processus (le démarrage de la CLI Prisma prend plusieurs secondes).
    for (let i = 0; i < 600 && !killed && !settled; i++) {
      const r = await su.query(`select pg_terminate_backend(pid) as k from pg_stat_activity where query ilike '%CREATE INDEX CONCURRENTLY%' and pid <> pg_backend_pid() and datname = current_database()`);
      killed = r.rows.some((row) => row.k);
      await new Promise((res) => setTimeout(res, 100));
    }
    await su.end();
    expect(killed).toBe(true);
    expect((await done).code).not.toBe(0);
    const c = await connectAs('cp_owner', db);
    expect(await findInvalidIndexes(c, 'app')).toEqual(['big_v_idx']);
    await c.end();
  });
});
