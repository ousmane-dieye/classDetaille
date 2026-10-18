import { beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });

async function expectDenied(role: 'cp_app' | 'cp_ops' | 'cp_monitor', sql: string, code = '42501'): Promise<void> {
  const c = await connectAs(role, db);
  try {
    await expect(c.query(sql)).rejects.toMatchObject({ code });
  } finally {
    await c.end();
  }
}

describe('droits de cp_app (§ 2.1, § 2.6)', () => {
  it('ne peut pas créer de table dans app', () => expectDenied('cp_app', 'create table app.x (id int)'));
  it('ne peut pas créer de table dans public', () => expectDenied('cp_app', 'create table public.x (id int)'));
  it('ne peut pas créer de table temporaire', () => expectDenied('cp_app', 'create temp table x (id int)'));
  it('ne peut pas prendre le rôle cp_privileged', () => expectDenied('cp_app', 'set role cp_privileged'));
  it('ne peut pas désactiver les triggers', () => expectDenied('cp_app', "set session_replication_role = 'replica'"));
  it('ne peut pas modifier sync_epoch', () => expectDenied('cp_app', 'update app.sync_epoch set epoch = gen_random_uuid()'));
  // priv reste fermé : cp_app n'en obtient que l'accès syntaxique, pour la seule fonction d'anonymisation
  // qui lui est explicitement accordée (R4, § 2.6). Aucune lecture de table, aucune création d'objet.
  // On passe par les OID : cp_owner n'a lui-même aucun USAGE sur priv, et la résolution d'un nom de
  // schéma par has_*_privilege exigerait ce droit.
  it("n'a sur priv que l'accès au schéma : pas de CREATE, ni d'exécution d'une autre fonction", async () => {
    const c = await connectAs('cp_owner', db);
    try {
      const r = await c.query(
        `select has_schema_privilege('cp_app', n.oid, 'USAGE')  as usage,
                has_schema_privilege('cp_app', n.oid, 'CREATE') as create_priv
           from pg_namespace n where n.nspname = 'priv'`,
      );
      expect(r.rows[0]).toMatchObject({ usage: true, create_priv: false });
      const f = await c.query(
        `select p.proname as name, has_function_privilege('cp_app', p.oid, 'EXECUTE') as executable
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'priv' order by p.proname`,
      );
      expect(f.rows).toEqual([
        { name: 'anonymize_user', executable: true }, // la seule accordée (R4)
        { name: 'issue_admin_recovery_code', executable: false },
      ]);
    } finally { await c.end(); }
  });
  it('peut lire sync_epoch', async () => {
    const c = await connectAs('cp_app', db);
    try {
      const r = await c.query('select epoch from app.sync_epoch where id = 1');
      expect(r.rowCount).toBe(1);
    } finally {
      await c.end();
    }
  });
});

describe('fonction priv.issue_admin_recovery_code et droits de cp_ops (§ 3.3)', () => {
  it('propriétaire cp_privileged, SECURITY DEFINER, chemin de recherche figé, EXECUTE pour cp_ops seulement', async () => {
    const c = await connectAs('cp_owner', db);
    try {
      const r = await c.query(
        `select pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig, p.proacl::text[] as acl
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'priv' and p.proname = 'issue_admin_recovery_code'`);
      expect(r.rows[0].owner).toBe('cp_privileged');
      expect(r.rows[0].prosecdef).toBe(true);
      expect(r.rows[0].proconfig).toContain('search_path=pg_catalog, pg_temp');
      // Liste exacte : le propriétaire et cp_ops ; rien pour PUBLIC (grantee vide) ni cp_app.
      expect([...r.rows[0].acl].sort()).toEqual(['cp_ops=X/cp_privileged', 'cp_privileged=X/cp_privileged']);
    } finally { await c.end(); }
  });
  it('cp_app ne peut pas appeler la fonction', () =>
    expectDenied('cp_app', `select priv.issue_admin_recovery_code('a@example.com', gen_random_uuid(), decode(repeat('00', 32), 'hex'), false)`));
  it.each(['users', 'sessions', 'auth_challenges', 'audit_log', 'email_outbox'])('cp_ops ne lit pas app.%s directement', (table) =>
    expectDenied('cp_ops', `select 1 from app.${table} limit 1`));
});
