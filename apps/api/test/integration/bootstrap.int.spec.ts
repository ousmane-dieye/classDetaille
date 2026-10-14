import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { PG_IMAGE } from '../support/images.js';
import { connectAs, createTestDatabase, execInPg, runSql } from '../support/pg.js';

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
                (select d.datacl is not null from pg_database d where d.datname = current_database())
                  and not exists (select 1 from pg_database d, unnest(d.datacl) a
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

/**
 * ACL posée par db/db-bootstrap-database.sql, lue sur une base créée par le script lui-même
 * (createTestDatabase réapplique l'ACL : la vérifier sur une base de test ne prouverait rien sur le script).
 */
async function aclOf(database: string) {
  const c = await connectAs('postgres', 'postgres');
  try {
    const { rows } = await c.query(
      `select d.datacl is not null as acl_set,
              not exists (select 1 from unnest(d.datacl) a where a::text like '=%') as no_public_acl,
              pg_get_userbyid(d.datdba) as owner,
              has_database_privilege('cp_app', d.datname, 'CONNECT') as app_connect,
              has_database_privilege('cp_app', d.datname, 'TEMPORARY') as app_temp,
              has_database_privilege('cp_monitor', d.datname, 'TEMPORARY') as mon_temp
         from pg_database d where d.datname = $1`,
      [database],
    );
    return rows[0];
  } finally { await c.end(); }
}
const EXPECTED_ACL = { acl_set: true, no_public_acl: true, owner: 'cp_owner', app_connect: true, app_temp: false, mon_temp: false };

describe('script db-bootstrap-database.sql (ACL de la base)', () => {
  it('la base modèle, créée par le script, ne donne rien à PUBLIC', async () => {
    expect(await aclOf(inject('pg').templateDb)).toEqual(EXPECTED_ACL);
  });

  it('le script est rejouable : deux exécutions sur une base neuve réussissent, ACL correcte ensuite', async () => {
    const name = `b_${randomBytes(6).toString('hex')}`;
    try {
      for (let run = 1; run <= 2; run++) {
        const r = await execInPg(['psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-v', `dbname=${name}`, '-f', '/bootstrap/db-bootstrap-database.sql']);
        expect(r.exitCode, `exécution ${run} : ${r.output}`).toBe(0);
      }
      expect(await aclOf(name)).toEqual(EXPECTED_ACL);
    } finally {
      await runSql('postgres', `DROP DATABASE IF EXISTS ${name}`);
    }
  });
});
