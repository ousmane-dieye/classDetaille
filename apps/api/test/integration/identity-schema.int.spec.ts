import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';
import { expectExactCpAppPrivileges, privKey } from '../support/privileges.js';

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
  it('cp_app ne peut ni supprimer un compte, ni changer l’email d’un étudiant, son rôle ou son statut', async () => {
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
  const USERS = ['id', 'email', 'first_name', 'last_name', 'password_hash', 'global_role', 'status', 'email_flagged_at', 'email_reminders', 'email_announcements', 'unsubscribe_token_hash', 'deleted_at', 'created_at', 'updated_at', 'second_factor_blocked_at'];
  const SESSIONS = ['id', 'token_hash', 'user_id', 'created_at', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'reauth_at', 'ip', 'user_agent', 'revoked_at', 'revoke_reason', 'second_factor_at', 'second_factor_method', 'step_up_at'];
  const CLASSES = ['id', 'name', 'level', 'academic_year', 'status', 'archived_at', 'created_at', 'updated_at'];
  const ENROLLMENTS = ['id', 'user_id', 'class_id', 'status', 'created_at', 'decided_at', 'decided_by', 'decision_note'];
  const AUDIT = ['id', 'occurred_at', 'source', 'db_login_role', 'actor_user_id', 'action', 'target_type', 'target_id', 'metadata'];
  const BUCKETS = ['key', 'window_start', 'attempts', 'failures', 'last_failure_at'];
  const CHALLENGES = ['id', 'user_id', 'purpose', 'session_id', 'token_hash', 'code_hmac', 'pending_email', 'ip', 'attempts', 'created_at', 'expires_at', 'consumed_at', 'consumed_reason'];
  const FAILURES = ['id', 'user_id', 'challenge_id', 'purpose', 'occurred_at'];
  const RESETS = ['id', 'user_id', 'token_hash', 'created_at', 'expires_at', 'consumed_at'];
  const OUTBOX = ['id', 'recipient_user_id', 'to_address', 'kind', 'dedupe_key', 'payload', 'payload_encrypted', 'message_id', 'status', 'normal_attempts', 'ambiguous_retry_scheduled', 'ambiguous_retry_claimed', 'next_attempt_at', 'locked_until', 'claim_token', 'expires_at', 'accepted_at', 'challenge_id', 'created_at'];
  const ATTEMPTS = ['id', 'email_id', 'attempt_no', 'kind', 'claim_token', 'started_at', 'finished_at', 'outcome', 'smtp_code', 'smtp_response', 'error_code', 'late_outcome', 'late_smtp_code'];
  const LEASES = ['name', 'holder', 'lease_until', 'fencing_token'];
  const key = privKey;

  // Oracle écrit à la main : droits de table.
  const TABLE_GRANTS = [
    key('rate_limit_buckets', 'DELETE'), key('rate_limit_buckets', 'INSERT'), key('rate_limit_buckets', 'SELECT'), key('rate_limit_buckets', 'UPDATE'),
    key('role_guard', 'SELECT'),
    key('sessions', 'INSERT'), key('sessions', 'SELECT'),
    key('users', 'SELECT'),
    key('classes', 'SELECT'),
    key('enrollment_requests', 'SELECT'),
    // audit_log : SELECT en droit de table, INSERT par colonne seulement (aucun UPDATE ni DELETE).
    key('audit_log', 'SELECT'),
    // lot 1b : SELECT en droit de table, INSERT et UPDATE par colonne seulement (jamais de DELETE).
    key('auth_challenges', 'SELECT'), key('second_factor_failures', 'SELECT'), key('password_reset_tokens', 'SELECT'),
    key('email_outbox', 'SELECT'), key('email_attempts', 'SELECT'), key('job_leases', 'SELECT'),
  ];
  // Oracle écrit à la main : droits par colonne (information_schema.column_privileges inclut ceux issus d'un droit de table).
  const COLUMN_GRANTS = [
    ...BUCKETS.flatMap((c) => ['INSERT', 'SELECT', 'UPDATE'].map((p) => key('rate_limit_buckets', p, c))),
    key('role_guard', 'SELECT', 'id'), key('role_guard', 'UPDATE', 'id'),
    ...SESSIONS.flatMap((c) => ['INSERT', 'SELECT'].map((p) => key('sessions', p, c))),
    ...['last_seen_at', 'idle_expires_at', 'reauth_at', 'revoked_at', 'revoke_reason', 'step_up_at'].map((c) => key('sessions', 'UPDATE', c)),
    ...USERS.map((c) => key('users', 'SELECT', c)),
    ...['id', 'email', 'first_name', 'last_name', 'password_hash', 'global_role', 'status', 'created_at', 'updated_at'].map((c) => key('users', 'INSERT', c)),
    ...['email', 'first_name', 'last_name', 'password_hash', 'email_reminders', 'email_announcements', 'second_factor_blocked_at', 'updated_at'].map((c) => key('users', 'UPDATE', c)),
    ...CLASSES.map((c) => key('classes', 'SELECT', c)),
    ...['id', 'name', 'level', 'academic_year', 'created_at', 'updated_at'].map((c) => key('classes', 'INSERT', c)),
    key('classes', 'UPDATE', 'updated_at'),
    ...ENROLLMENTS.map((c) => key('enrollment_requests', 'SELECT', c)),
    ...['id', 'user_id', 'class_id', 'created_at'].map((c) => key('enrollment_requests', 'INSERT', c)),
    ...AUDIT.map((c) => key('audit_log', 'SELECT', c)),
    ...['actor_user_id', 'action', 'target_type', 'target_id', 'metadata'].map((c) => key('audit_log', 'INSERT', c)),
    ...CHALLENGES.map((c) => key('auth_challenges', 'SELECT', c)),
    ...['id', 'user_id', 'purpose', 'session_id', 'token_hash', 'code_hmac', 'pending_email', 'ip', 'expires_at'].map((c) => key('auth_challenges', 'INSERT', c)),
    ...['attempts', 'consumed_at', 'consumed_reason'].map((c) => key('auth_challenges', 'UPDATE', c)),
    ...FAILURES.map((c) => key('second_factor_failures', 'SELECT', c)),
    ...['user_id', 'challenge_id', 'purpose'].map((c) => key('second_factor_failures', 'INSERT', c)),
    ...RESETS.map((c) => key('password_reset_tokens', 'SELECT', c)),
    ...['id', 'user_id', 'token_hash', 'expires_at'].map((c) => key('password_reset_tokens', 'INSERT', c)),
    key('password_reset_tokens', 'UPDATE', 'consumed_at'),
    ...OUTBOX.map((c) => key('email_outbox', 'SELECT', c)),
    ...['id', 'recipient_user_id', 'to_address', 'kind', 'dedupe_key', 'payload', 'payload_encrypted', 'message_id', 'expires_at', 'challenge_id'].map((c) => key('email_outbox', 'INSERT', c)),
    ...['status', 'normal_attempts', 'ambiguous_retry_scheduled', 'ambiguous_retry_claimed', 'next_attempt_at', 'locked_until', 'claim_token', 'accepted_at', 'payload_encrypted'].map((c) => key('email_outbox', 'UPDATE', c)),
    ...ATTEMPTS.map((c) => key('email_attempts', 'SELECT', c)),
    ...['email_id', 'attempt_no', 'kind', 'claim_token'].map((c) => key('email_attempts', 'INSERT', c)),
    ...['finished_at', 'outcome', 'smtp_code', 'smtp_response', 'error_code', 'late_outcome', 'late_smtp_code'].map((c) => key('email_attempts', 'UPDATE', c)),
    ...LEASES.map((c) => key('job_leases', 'SELECT', c)),
    ...['holder', 'lease_until', 'fencing_token'].map((c) => key('job_leases', 'UPDATE', c)),
  ];
  const TABLES = ['users', 'sessions', 'rate_limit_buckets', 'role_guard', 'classes', 'enrollment_requests', 'audit_log', 'auth_challenges', 'second_factor_failures', 'password_reset_tokens', 'email_outbox', 'email_attempts', 'job_leases'];

  it('droits de table et droits par colonne : listes exactes (jamais de DELETE sur users, sessions, classes, demandes ni audit)', async () => {
    await expectExactCpAppPrivileges(db, TABLES, TABLE_GRANTS, COLUMN_GRANTS);
  });
});

describe('classes et enrollment_requests (§ 2.2, R8, R9)', () => {
  async function insertClass(name: string, year = '2026-2027', status = 'ACTIVE') {
    const id = uuidv7();
    await app.query(`insert into app.classes (id, name, level, academic_year) values ($1, $2, 'L3', $3)`, [id, name, year]);
    if (status === 'ARCHIVED') {
      // cp_app ne peut pas archiver au lot 1 : on passe par le propriétaire pour préparer la donnée.
      const owner = await connectAs('cp_owner', db);
      await owner.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [id]);
      await owner.end();
    }
    return id;
  }
  it('unicité (name, academic_year) et format de l’année', async () => {
    await insertClass('L3 Info');
    await expect(insertClass('L3 Info')).rejects.toMatchObject({ code: '23505' });
    await expect(insertClass('L3 Réseaux', '2026-2028')).rejects.toMatchObject({ constraint: 'classes_text_lengths' });
  });
  it('une année non numérique est refusée par la contrainte (23514), jamais par un cast (22P02)', async () => {
    await expect(insertClass('L3 Cast', 'abcd-abce')).rejects.toMatchObject({ code: '23514', constraint: 'classes_text_lengths' });
  });
  it('une seule demande en attente par utilisateur', async () => {
    const c1 = await insertClass('C1');
    const c2 = await insertClass('C2');
    const u = await insertUser('enr1@example.com');
    await app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c1]);
    await expect(app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c2])).rejects.toMatchObject({ code: '23505' });
  });
  it('refuse une demande pour une classe archivée', async () => {
    const c = await insertClass('C3', '2025-2026', 'ARCHIVED');
    const u = await insertUser('enr2@example.com');
    await expect(app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c])).rejects.toMatchObject({ code: '23514', message: 'enrollment: class is not active' });
  });
  it('refuse une demande d’un administrateur', async () => {
    const c = await insertClass('C4');
    const u = await insertUser('enr3@example.com', { global_role: 'ADMIN' });
    await expect(app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c])).rejects.toMatchObject({ code: '23514', message: 'enrollment: user cannot enroll' });
  });
  it('refuse une demande d’un compte non actif', async () => {
    const c = await insertClass('C4b');
    const u = await insertUser('enr3b@example.com', { status: 'SUSPENDED' });
    await expect(app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c])).rejects.toMatchObject({ code: '23514', message: 'enrollment: user cannot enroll' });
  });
  it('refuse une nouvelle demande pour la même classe moins de 24 h après un refus, l’accepte après', async () => {
    const c = await insertClass('C5');
    const u = await insertUser('enr4@example.com');
    const owner = await connectAs('cp_owner', db);
    const reqId = uuidv7();
    await app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [reqId, u, c]);
    await owner.query(`update app.enrollment_requests set status = 'REFUSED', decided_at = now() - interval '23 hours', decided_by = $2 where id = $1`, [reqId, u]);
    await expect(app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c])).rejects.toMatchObject({ code: '23514', message: 'enrollment: refused less than 24 hours ago' });
    await owner.query(`update app.enrollment_requests set decided_at = now() - interval '25 hours' where id = $1`, [reqId]);
    await owner.end();
    await app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c]);
  });
  it('cp_app ne peut pas encore décider une demande (lot 2)', async () => {
    await expect(app.query(`update app.enrollment_requests set status = 'ACCEPTED'`)).rejects.toMatchObject({ code: '42501' });
  });
});
