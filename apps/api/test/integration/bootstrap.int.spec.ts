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
    try {
      const { rows } = await c.query(
        `select rolname, rolsuper, rolcanlogin, rolcreatedb, rolcreaterole from pg_roles where rolname like 'cp\\_%' order by 1`,
      );
      expect(rows).toEqual([
        { rolname: 'cp_app', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
        { rolname: 'cp_monitor', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
        { rolname: 'cp_ops', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
        { rolname: 'cp_owner', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
        { rolname: 'cp_privileged', rolsuper: false, rolcanlogin: false, rolcreatedb: false, rolcreaterole: false },
      ]);
    } finally {
      await c.end();
    }
  });

  it('pose les délais de cp_app sur le rôle (setdatabase = 0)', async () => {
    const c = await connectAs('cp_app', db);
    try {
      const t = await c.query('show transaction_timeout');
      const i = await c.query('show idle_in_transaction_session_timeout');
      expect(t.rows[0].transaction_timeout).toBe('10s');
      expect(i.rows[0].idle_in_transaction_session_timeout).toBe('10s');
      const s = await c.query(
        `select s.setdatabase, s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'cp_app'`,
      );
      expect(s.rows.filter((r) => r.setdatabase !== 0 && r.setdatabase !== '0')).toEqual([]);
      const global = s.rows.filter((r) => r.setdatabase === 0 || r.setdatabase === '0');
      expect(global).toHaveLength(1);
      const config: string[] = global[0].setconfig;
      expect(config).toEqual(expect.arrayContaining([
        expect.stringMatching(/^transaction_timeout=10s$/),
        expect.stringMatching(/^idle_in_transaction_session_timeout=10s$/),
      ]));
    } finally {
      await c.end();
    }
  });

  it("retire CONNECT et TEMPORARY à PUBLIC sur la base", async () => {
    const c = await connectAs('cp_app', db);
    try {
      const { rows } = await c.query(
        `select has_database_privilege('cp_app', current_database(), 'TEMPORARY') as app_temp,
                has_database_privilege('cp_monitor', current_database(), 'TEMPORARY') as mon_temp,
                has_database_privilege('cp_app', current_database(), 'CONNECT') as app_connect,
                not exists (select 1 from pg_database d, unnest(d.datacl) a
                            where d.datname = current_database() and a::text like '=%') as no_public_acl`,
      );
      expect(rows[0]).toEqual({ app_temp: false, mon_temp: false, app_connect: true, no_public_acl: true });
    } finally {
      await c.end();
    }
  });

  it("n'accorde ni CREATE ni USAGE sur le schéma public aux rôles applicatifs", async () => {
    const c = await connectAs('cp_monitor', db);
    try {
      const { rows } = await c.query(
        `select r.role,
                has_schema_privilege(r.role, 'public', 'CREATE') as can_create,
                has_schema_privilege(r.role, 'public', 'USAGE') as can_use
           from (values ('cp_app'), ('cp_ops'), ('cp_monitor')) as r(role) order by 1`,
      );
      expect(rows).toEqual([
        { role: 'cp_app', can_create: false, can_use: false },
        { role: 'cp_monitor', can_create: false, can_use: false },
        { role: 'cp_ops', can_create: false, can_use: false },
      ]);
    } finally {
      await c.end();
    }
  });
});
