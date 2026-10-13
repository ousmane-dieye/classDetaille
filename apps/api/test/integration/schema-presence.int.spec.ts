import { beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });

describe('présence du schéma (§ 2.8)', () => {
  it('schémas, extensions et tables de fondation', async () => {
    const c = await connectAs('cp_monitor', db);
    const schemas = await c.query(`select nspname from pg_namespace where nspname in ('app','ext','priv') order by 1`);
    const ext = await c.query(`select e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where extname in ('citext','pgcrypto') order by 1`);
    const priv = await c.query(`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'priv'`);
    await c.end();
    expect(schemas.rows.map((r) => r.nspname)).toEqual(['app', 'ext', 'priv']);
    expect(ext.rows).toEqual([{ extname: 'citext', nspname: 'ext' }, { extname: 'pgcrypto', nspname: 'ext' }]);
    expect(priv.rows[0].owner).toBe('cp_privileged');
  });

  it('une seule ligne dans sync_epoch et ops_settings, lisibles par cp_app', async () => {
    const c = await connectAs('cp_app', db);
    const e = await c.query('select count(*)::int as n from app.sync_epoch');
    const o = await c.query('select count(*)::int as n from app.ops_settings');
    await c.end();
    expect(e.rows[0].n).toBe(1);
    expect(o.rows[0].n).toBe(1);
  });

  it('la migration de fondation est enregistrée par Prisma', async () => {
    const c = await connectAs('cp_owner', db);
    const r = await c.query(`select migration_name, finished_at is not null as done from app._prisma_migrations`);
    await c.end();
    expect(r.rows).toEqual([{ migration_name: '20261013000000_foundations', done: true }]);
  });
});
