import { beforeAll, describe, expect, it } from 'vitest';
import { PG_IMAGE } from '../support/images.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });

describe('initialisation de la base', () => {
  it("l'image PostgreSQL est fixée par empreinte", () => {
    expect(PG_IMAGE).toMatch(/^postgres:18@sha256:[0-9a-f]{64}$/);
  });

  it('crée les rôles avec les bons attributs', async () => {
    const c = await connectAs('cp_monitor', db);
    const { rows } = await c.query(
      `select rolname, rolsuper, rolcanlogin, rolcreatedb, rolcreaterole from pg_roles where rolname like 'cp\\_%' order by 1`,
    );
    await c.end();
    expect(rows).toEqual([
      { rolname: 'cp_app', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
      { rolname: 'cp_monitor', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
      { rolname: 'cp_ops', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
      { rolname: 'cp_owner', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
      { rolname: 'cp_privileged', rolsuper: false, rolcanlogin: false, rolcreatedb: false, rolcreaterole: false },
    ]);
  });

  it('pose les délais de cp_app sur le rôle (setdatabase = 0)', async () => {
    const c = await connectAs('cp_app', db);
    const t = await c.query('show transaction_timeout');
    const i = await c.query('show idle_in_transaction_session_timeout');
    await c.end();
    expect(t.rows[0].transaction_timeout).toBe('10s');
    expect(i.rows[0].idle_in_transaction_session_timeout).toBe('10s');
  });

  it("retire CONNECT et TEMPORARY à PUBLIC sur la base", async () => {
    const c = await connectAs('cp_app', db);
    const { rows } = await c.query(
      `select has_database_privilege('cp_app', current_database(), 'TEMPORARY') as app_temp,
              has_database_privilege('cp_monitor', current_database(), 'TEMPORARY') as mon_temp`,
    );
    await c.end();
    expect(rows[0]).toEqual({ app_temp: false, mon_temp: false });
  });
});
