import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, PASSWORD, registerStudent, send, type TestApp } from '../support/app.js';
import { connectAs, createTestDatabase } from '../support/pg.js';
import { createAdmin } from '../support/second-factor.js';

let db: string;
let t: TestApp;
let sql: pg.Client;
let classA: string;
let classB: string;

const errorOf = (res: { json: () => unknown }): Record<string, unknown> => (res.json() as { error: Record<string, unknown> }).error;

/** Un refus de base vient toujours du déclencheur ou du grant, jamais d'une erreur 500. */
async function expectDenied(statement: string, code = '42501'): Promise<void> {
  const c = await connectAs('cp_app', db);
  try {
    await expect(c.query(statement)).rejects.toMatchObject({ code });
  } finally {
    await c.end();
  }
}

/** Appartenance active insérée sous cp_app : l'inscription ne crée qu'une demande en attente. */
async function acceptAndJoin(userId: string, classId: string): Promise<void> {
  await sql.query(
    `update app.enrollment_requests set status = 'ACCEPTED', decided_at = now(), decided_by = $2 where user_id = $1 and class_id = $3 and status = 'PENDING'`,
    [userId, userId, classId],
  );
  await sql.query(`insert into app.class_memberships (id, user_id, class_id, role) values (gen_random_uuid(), $1, $2, 'STUDENT')`, [userId, classId]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  sql = await connectAs('cp_app', db);
  t = await buildTestApp(db);
  classA = await insertClass(db, 'L3 Anonyme A');
  classB = await insertClass(db, 'L3 Anonyme B');
});

afterAll(async () => {
  await sql.end();
  await t.close();
});

describe('POST /api/me/account (R4, § 2.6)', () => {
  it('un mot de passe faux vaut 400 CURRENT_PASSWORD_INVALID : le compte et la session survivent', async () => {
    const s = await registerStudent(t.app, classA);
    const res = await send(t.app, 'POST', '/api/me/account', { password: 'un autre mot de passe' }, cookieHeader(s.token));
    expect([res.statusCode, errorOf(res).code]).toEqual([400, 'CURRENT_PASSWORD_INVALID']);
    expect((await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token))).statusCode).toBe(200);
    const u = await sql.query(`select status, deleted_at from app.users where id = $1`, [s.userId]);
    expect(u.rows[0]).toMatchObject({ status: 'ACTIVE', deleted_at: null });
  });

  it("anonymisation complète : DELETED, identité effacée, sessions ANONYMIZED, appartenance ACCOUNT_DELETED, notes effacées, emails annulés, double audit", async () => {
    const s = await registerStudent(t.app, classA);
    // La demande d'inscription est tranchée avec un motif : il appartient au compte et doit disparaître (§ 2.6).
    await sql.query(
      `update app.enrollment_requests set status = 'REFUSED', decided_at = now(), decided_by = $2, decision_note = 'motif interne'
        where user_id = $1 and class_id = $3 and status = 'PENDING'`,
      [s.userId, s.userId, classA],
    );
    // L'appartenance est d'abord clôturée avec un motif, puis une nouvelle est ouverte : la première garde
    // son motif (elle est close) mais pas sa note — cp_app ne peut pas insérer une ligne déjà close.
    await acceptAndJoin(s.userId, classA);
    await sql.query(
      `update app.class_memberships set left_at = now() - interval '1 hour', left_reason = 'REMOVED', left_note = 'motif de retrait'
        where user_id = $1 and class_id = $2`,
      [s.userId, classA],
    );
    await sql.query(`insert into app.class_memberships (id, user_id, class_id, role, joined_at) values ($1, $2, $3, 'STUDENT', now())`, [uuidv7(), s.userId, classB]);
    // Un email en attente : annulé, adresse et contenu vidés.
    await sql.query(
      `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, message_id, expires_at)
       values ($1, $2, $3, 'DIGEST', $4, '{"ligne":"avant"}', $5, now() + interval '1 day')`,
      [uuidv7(), s.userId, s.email, `digest:${s.userId}`, uuidv7()],
    );

    expect((await send(t.app, 'POST', '/api/me/account', { password: PASSWORD }, cookieHeader(s.token))).statusCode).toBe(204);

    const u = (
      await sql.query(
        `select status, global_role, email, first_name, last_name, password_hash, email_flagged_at, unsubscribe_token_hash,
                email_reminders, email_announcements, deleted_at
           from app.users where id = $1`,
        [s.userId],
      )
    ).rows[0];
    expect(u).toMatchObject({
      status: 'DELETED',
      global_role: 'USER',
      email: null,
      first_name: null,
      last_name: null,
      password_hash: null,
      email_flagged_at: null,
      unsubscribe_token_hash: null,
      email_reminders: false,
      email_announcements: false,
    });
    expect(u.deleted_at).not.toBeNull();

    const sessions = await sql.query(`select revoke_reason from app.sessions where user_id = $1`, [s.userId]);
    expect(sessions.rows.length).toBeGreaterThan(0);
    for (const row of sessions.rows) expect(row.revoke_reason).toBe('ANONYMIZED');

    const active = (await sql.query(`select left_reason, left_by, left_note from app.class_memberships where user_id = $1 and class_id = $2`, [s.userId, classB])).rows[0];
    expect(active).toMatchObject({ left_reason: 'ACCOUNT_DELETED', left_by: null, left_note: null });
    const old = (await sql.query(`select left_reason, left_note from app.class_memberships where user_id = $1 and class_id = $2`, [s.userId, classA])).rows[0];
    expect(old.left_reason).toBe('REMOVED'); // le motif d'origine est conservé
    expect(old.left_note).toBeNull(); // seule la note, qui appartenait au compte, disparaît

    const decided = (await sql.query(`select status, decided_at, decided_by, decision_note from app.enrollment_requests where user_id = $1`, [s.userId])).rows[0];
    expect(decided.status).toBe('REFUSED'); // la décision d'origine n'est pas réécrite, seule la note part
    expect(decided.decided_at).not.toBeNull();
    expect(decided.decision_note).toBeNull();

    const mail = (
      await sql.query(`select status, to_address, payload, payload_encrypted, claim_token, locked_until from app.email_outbox where recipient_user_id = $1`, [s.userId])
    ).rows[0];
    expect(mail).toMatchObject({ status: 'CANCELLED', to_address: '', payload: {}, payload_encrypted: null, claim_token: null, locked_until: null });

    const audits = await sql.query(
      `select action, source, actor_user_id, target_type, target_id from app.audit_log
        where target_id = $1 and action in ('ACCOUNT_DELETED', 'ACCOUNT_ANONYMIZED') order by id`,
      [s.userId],
    );
    expect(audits.rows).toEqual([
      // La demande (APP) est déclarative ; l'effacement (PRIVILEGED) est garanti par la base (§ 2.5).
      { action: 'ACCOUNT_DELETED', source: 'APP', actor_user_id: s.userId, target_type: 'USER', target_id: s.userId },
      { action: 'ACCOUNT_ANONYMIZED', source: 'PRIVILEGED', actor_user_id: s.userId, target_type: 'USER', target_id: s.userId },
    ]);
  });

  it('une demande en attente est annulée, pas acceptée ni refusée', async () => {
    // Un compte ne peut cumuler demande en attente et appartenance (déclencheur R9) : ici, ni l'une ni l'autre.
    const s = await registerStudent(t.app, classA);
    expect((await send(t.app, 'POST', '/api/me/account', { password: PASSWORD }, cookieHeader(s.token))).statusCode).toBe(204);
    const r = (await sql.query(`select status, decided_at, decided_by, decision_note from app.enrollment_requests where user_id = $1`, [s.userId])).rows[0];
    expect(r).toMatchObject({ status: 'CANCELLED', decided_by: null, decision_note: null });
    expect(r.decided_at).not.toBeNull(); // la clôture est datée, mais il n'y a eu aucun décideur
    // La place est libre : le compte supprimé peut être ré-inscrit par un administrateur sans buter.
    expect((await sql.query(`select count(*)::int as n from app.enrollment_requests where user_id = $1 and status = 'PENDING'`, [s.userId])).rows[0].n).toBe(0);
  });

  it("après suppression : la session vaut 401 et la reconnexion aussi, jamais d'erreur 500", async () => {
    const s = await registerStudent(t.app, classA);
    const email = s.email;
    expect((await send(t.app, 'POST', '/api/me/account', { password: PASSWORD }, cookieHeader(s.token))).statusCode).toBe(204);
    const me = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token));
    expect([me.statusCode, errorOf(me).code]).toEqual([401, 'UNAUTHENTICATED']);
    const login = await send(t.app, 'POST', '/api/auth/login', { email, password: PASSWORD });
    expect(login.statusCode).toBe(401);
    expect(login.statusCode).toBeLessThan(500);
  });

  it("aucune ligne n'est supprimée : compte, appartenance et demande sont conservés sous pseudonyme", async () => {
    const s = await registerStudent(t.app, classA);
    await acceptAndJoin(s.userId, classA);
    expect((await send(t.app, 'POST', '/api/me/account', { password: PASSWORD }, cookieHeader(s.token))).statusCode).toBe(204);
    const counts = (
      await sql.query(
        `select (select count(*)::int from app.users where id = $1)                 as users,
                (select count(*)::int from app.class_memberships where user_id = $1)  as memberships,
                (select count(*)::int from app.enrollment_requests where user_id = $1) as requests`,
        [s.userId],
      )
    ).rows[0];
    // § 2.6 : devoirs, ressources et messages n'existent pas encore au lot 2 ; la garantie déjà vérifiable
    // est qu'aucune ligne n'est jamais supprimée.
    expect(counts).toEqual({ users: 1, memberships: 1, requests: 1 });
  });
});

describe("audit ACCOUNT_ANONYMIZED et limite d'activité (§ 2.5, § 2.6)", () => {
  it("ACCOUNT_ANONYMIZED est refusé en source APP : seul priv.anonymize_user l'écrit, en PRIVILEGED", async () => {
    const target = uuidv7();
    await expect(
      sql.query(`insert into app.audit_log (actor_user_id, action, target_type, target_id, metadata) values ($1, 'ACCOUNT_ANONYMIZED', 'USER', $1, '{}')`, [target]),
    ).rejects.toMatchObject({ code: '42501' });

    const s = await registerStudent(t.app, classA);
    await sql.query(`select priv.anonymize_user($1::uuid, $2::uuid)`, [s.userId, s.userId]);
    const row = (await sql.query(`select source, actor_user_id from app.audit_log where action = 'ACCOUNT_ANONYMIZED' and target_id = $1`, [s.userId])).rows[0];
    expect(row).toMatchObject({ source: 'PRIVILEGED', actor_user_id: s.userId });
  });

  it('6e anonymisation du même acteur en 24 h → refus, les cinq précédentes restent faites', async () => {
    // L'acteur doit être autorisé : un administrateur qui supprime plusieurs comptes.
    const admin = await createAdmin(db);
    for (let i = 0; i < 5; i++) {
      const s = await registerStudent(t.app, classA);
      await sql.query(`select priv.anonymize_user($1::uuid, $2::uuid)`, [s.userId, admin.id]);
    }
    const sixth = await registerStudent(t.app, classA);
    await expect(sql.query(`select priv.anonymize_user($1::uuid, $2::uuid)`, [sixth.userId, admin.id])).rejects.toMatchObject({ code: 'P0003' });
    // Refus avant toute écriture : le sixième compte est intact.
    expect((await sql.query(`select status from app.users where id = $1`, [sixth.userId])).rows[0].status).toBe('ACTIVE');
    expect((await sql.query(`select count(*)::int as n from app.audit_log where action = 'ACCOUNT_ANONYMIZED' and target_id = $1`, [sixth.userId])).rows[0].n).toBe(0);
    // Un autre acteur n'est pas gêné par la limite.
    const other = await registerStudent(t.app, classA);
    const otherAdmin = await createAdmin(db);
    await sql.query(`select priv.anonymize_user($1::uuid, $2::uuid)`, [other.userId, otherAdmin.id]);
    expect((await sql.query(`select status from app.users where id = $1`, [other.userId])).rows[0].status).toBe('DELETED');
  });

  it('un acteur qui n’est ni la cible ni un administrateur actif est refusé', async () => {
    const s = await registerStudent(t.app, classA);
    await expect(sql.query(`select priv.anonymize_user($1::uuid, $2::uuid)`, [s.userId, uuidv7()])).rejects.toMatchObject({ code: 'P0003' });
    expect((await sql.query(`select status from app.users where id = $1`, [s.userId])).rows[0].status).toBe('ACTIVE');
  });
});

describe('droits sur priv.anonymize_user (§ 2.6)', () => {
  it('cp_app ne peut ni prendre le rôle cp_privileged, ni créer, remplacer ou supprimer la fonction', async () => {
    await expectDenied('set role cp_privileged');
    await expectDenied(`create function priv.x_anonymize(u uuid) returns void language sql as 'select 1'`);
    await expectDenied(`create or replace function priv.anonymize_user(u uuid, a uuid) returns void language sql as 'select 1'`);
    await expectDenied(`drop function priv.anonymize_user(uuid, uuid)`);
  });

  it('propriétaire cp_privileged, SECURITY DEFINER, chemin de recherche figé, EXECUTE pour cp_app seulement', async () => {
    const c = await connectAs('cp_owner', db);
    try {
      const r = await c.query(
        `select pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig, p.proacl::text[] as acl
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'priv' and p.proname = 'anonymize_user'`,
      );
      expect(r.rows[0].owner).toBe('cp_privileged');
      expect(r.rows[0].prosecdef).toBe(true);
      expect(r.rows[0].proconfig).toContain('search_path=pg_catalog, pg_temp');
      // cp_app n'a que l'exécution de cette seule fonction (et l'usage du schéma qui va avec).
      expect([...r.rows[0].acl].sort()).toEqual(['cp_app=X/cp_privileged', 'cp_privileged=X/cp_privileged']);
    } finally {
      await c.end();
    }
  });

  it('cp_app ne peut pas créer ni supprimer d’objet dans priv', async () => {
    await expectDenied('create table priv.x (id int)');
    await expectDenied('drop schema priv cascade', '42501');
  });
});
