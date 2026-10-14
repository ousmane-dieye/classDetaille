import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let app: pg.Client;
beforeAll(async () => { db = await createTestDatabase(); app = await connectAs('cp_app', db); });
afterAll(async () => { await app.end(); });

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';
async function insertUser(email: string, extra: Record<string, unknown> = {}) {
  const id = uuidv7();
  const cols = { id, email, first_name: 'Awa', last_name: 'Diop', password_hash: HASH, ...extra };
  const keys = Object.keys(cols);
  await app.query(`insert into app.users (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols));
  return id;
}

describe('users (§ 2.2)', () => {
  it('insère un compte ACTIVE avec les valeurs par défaut', async () => {
    const id = await insertUser('awa@example.com');
    const r = await app.query('select global_role, status, email_reminders, email_announcements from app.users where id = $1', [id]);
    expect(r.rows[0]).toEqual({ global_role: 'USER', status: 'ACTIVE', email_reminders: true, email_announcements: true });
  });
  it('unicité de l’email insensible à la casse (citext)', async () => {
    await insertUser('dup@example.com');
    await expect(insertUser('DUP@example.com')).rejects.toMatchObject({ code: '23514' }); // non normalisé
    await expect(insertUser('dup@example.com')).rejects.toMatchObject({ code: '23505' });
  });
  it.each([' x@example.com', 'X@example.com', 'é@example.com', 'sans-arobase'])('refuse un email non normalisé %j', async (email) => {
    await expect(insertUser(email)).rejects.toMatchObject({ code: '23514', constraint: 'users_email_normalized' });
  });
  it('users_lifecycle : un compte ACTIVE sans mot de passe est refusé', async () => {
    await expect(insertUser('nopw@example.com', { password_hash: null })).rejects.toMatchObject({ constraint: 'users_lifecycle' });
  });
  it('users_lifecycle : un compte DELETED doit avoir tout effacé', async () => {
    await expect(insertUser('del@example.com', { status: 'DELETED' })).rejects.toMatchObject({ constraint: 'users_lifecycle' });
  });
  it('cp_app ne peut ni supprimer un compte, ni changer son email, son rôle ou son statut', async () => {
    const id = await insertUser('rights@example.com');
    await expect(app.query('delete from app.users where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.users set email = 'z@example.com' where id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.users set global_role = 'ADMIN' where id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.users set status = 'SUSPENDED' where id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('sessions (§ 2.2, § 3.4)', () => {
  async function insertSession(userId: string, extra: Record<string, unknown> = {}) {
    const cols = { id: uuidv7(), token_hash: randomBytes(32), user_id: userId, idle_expires_at: new Date(Date.now() + 3600_000), absolute_expires_at: new Date(Date.now() + 7200_000), ...extra };
    const keys = Object.keys(cols);
    await app.query(`insert into app.sessions (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols));
    return cols.id as string;
  }
  it('le hachage du jeton fait 32 octets', async () => {
    const u = await insertUser('s1@example.com');
    await expect(insertSession(u, { token_hash: randomBytes(16) })).rejects.toMatchObject({ constraint: 'sessions_token_hash_len' });
  });
  it('révocation : date et motif ensemble', async () => {
    const u = await insertUser('s2@example.com');
    const s = await insertSession(u);
    await expect(app.query('update app.sessions set revoked_at = clock_timestamp() where id = $1', [s])).rejects.toMatchObject({ constraint: 'sessions_revocation' });
    await app.query(`update app.sessions set revoked_at = clock_timestamp(), revoke_reason = 'LOGOUT' where id = $1`, [s]);
  });
  it('une révocation est définitive', async () => {
    const u = await insertUser('s3@example.com');
    const s = await insertSession(u);
    await app.query(`update app.sessions set revoked_at = clock_timestamp(), revoke_reason = 'LOGOUT' where id = $1`, [s]);
    await expect(app.query('update app.sessions set revoked_at = null, revoke_reason = null where id = $1', [s])).rejects.toMatchObject({ code: '23514' });
  });
  it('cp_app ne peut pas supprimer une session ni changer son jeton', async () => {
    const u = await insertUser('s4@example.com');
    const s = await insertSession(u);
    await expect(app.query('delete from app.sessions where id = $1', [s])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('update app.sessions set token_hash = $2 where id = $1', [s, randomBytes(32)])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('rate_limit_buckets et role_guard', () => {
  it.each(['ip:203.0.113.7', 'ip:2001:db8:1:2::', `ip+acct:203.0.113.7:${'a'.repeat(64)}`])('accepte la clé %s', async (key) => {
    await app.query('insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp())', [key]);
  });
  it.each(['user:alice', 'ip:', `ip+acct:1.2.3.4:alice@example.com`])('refuse la clé %s', async (key) => {
    await expect(app.query('insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp())', [key])).rejects.toMatchObject({ constraint: 'rate_limit_key_shape' });
  });
  it('role_guard a une seule ligne, verrouillable par cp_app', async () => {
    const r = await app.query('select id from app.role_guard');
    expect(r.rows).toEqual([{ id: 1 }]);
    await app.query('begin');
    await app.query('select id from app.role_guard where id = 1 for update');
    await app.query('rollback');
    await expect(app.query('insert into app.role_guard values (2)')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('catalogue exact des droits de cp_app (§ 2.2, § 2.6)', () => {
  const USERS = ['id', 'email', 'first_name', 'last_name', 'password_hash', 'global_role', 'status', 'email_flagged_at', 'email_reminders', 'email_announcements', 'unsubscribe_token_hash', 'deleted_at', 'created_at', 'updated_at'];
  const SESSIONS = ['id', 'token_hash', 'user_id', 'created_at', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'reauth_at', 'ip', 'user_agent', 'revoked_at', 'revoke_reason'];
  const BUCKETS = ['key', 'window_start', 'attempts', 'failures', 'last_failure_at'];
  const key = (t: string, p: string, c = '') => `${t}|${p}|${c}`;

  // Oracle écrit à la main : droits de table.
  const TABLE_GRANTS = [
    key('rate_limit_buckets', 'DELETE'), key('rate_limit_buckets', 'INSERT'), key('rate_limit_buckets', 'SELECT'), key('rate_limit_buckets', 'UPDATE'),
    key('role_guard', 'SELECT'),
    key('sessions', 'INSERT'), key('sessions', 'SELECT'),
    key('users', 'SELECT'),
  ];
  // Oracle écrit à la main : droits par colonne (information_schema.column_privileges inclut ceux issus d'un droit de table).
  const COLUMN_GRANTS = [
    ...BUCKETS.flatMap((c) => ['INSERT', 'SELECT', 'UPDATE'].map((p) => key('rate_limit_buckets', p, c))),
    key('role_guard', 'SELECT', 'id'), key('role_guard', 'UPDATE', 'id'),
    ...SESSIONS.flatMap((c) => ['INSERT', 'SELECT'].map((p) => key('sessions', p, c))),
    ...['last_seen_at', 'idle_expires_at', 'reauth_at', 'revoked_at', 'revoke_reason'].map((c) => key('sessions', 'UPDATE', c)),
    ...USERS.map((c) => key('users', 'SELECT', c)),
    ...['id', 'email', 'first_name', 'last_name', 'password_hash', 'global_role', 'status', 'created_at', 'updated_at'].map((c) => key('users', 'INSERT', c)),
    ...['first_name', 'last_name', 'password_hash', 'email_reminders', 'email_announcements', 'updated_at'].map((c) => key('users', 'UPDATE', c)),
  ];
  const TABLES = `('users','sessions','rate_limit_buckets','role_guard')`;

  it('droits de table : liste exacte, sans DELETE sur users ni sessions', async () => {
    const owner = await connectAs('cp_owner', db);
    try {
      const r = await owner.query(
        `select grantee, table_name, privilege_type, is_grantable from information_schema.role_table_grants
          where table_schema = 'app' and table_name in ${TABLES} and grantee <> 'cp_owner'`,
      );
      expect(r.rows.every((x) => x.grantee === 'cp_app' && x.is_grantable === 'NO')).toBe(true);
      expect(r.rows.map((x) => key(x.table_name, x.privilege_type)).sort()).toEqual([...TABLE_GRANTS].sort());
      const del = r.rows.filter((x) => x.privilege_type === 'DELETE').map((x) => x.table_name);
      expect(del).toEqual(['rate_limit_buckets']);
    } finally { await owner.end(); }
  });

  it('droits par colonne : liste exacte', async () => {
    const owner = await connectAs('cp_owner', db);
    try {
      const r = await owner.query(
        `select grantee, table_name, column_name, privilege_type, is_grantable from information_schema.column_privileges
          where table_schema = 'app' and table_name in ${TABLES} and grantee <> 'cp_owner'`,
      );
      expect(r.rows.every((x) => x.grantee === 'cp_app' && x.is_grantable === 'NO')).toBe(true);
      expect(r.rows.map((x) => key(x.table_name, x.privilege_type, x.column_name)).sort()).toEqual([...COLUMN_GRANTS].sort());
    } finally { await owner.end(); }
  });
});
