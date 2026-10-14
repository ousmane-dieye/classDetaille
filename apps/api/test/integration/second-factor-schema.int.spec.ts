import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let app: pg.Client;
let owner: pg.Client;
beforeAll(async () => { db = await createTestDatabase(); app = await connectAs('cp_app', db); owner = await connectAs('cp_owner', db); });
afterAll(async () => { await app.end(); await owner.end(); });

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';
async function insertUser(email: string, role: 'USER' | 'ADMIN' = 'ADMIN') {
  const id = uuidv7();
  await app.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,$2,'Awa','Diop',$3,$4)`, [id, email, HASH, role]);
  return id;
}
async function insertSession(userId: string, secondFactor = true) {
  const id = uuidv7();
  await app.query(
    `insert into app.sessions (id, token_hash, user_id, idle_expires_at, absolute_expires_at, second_factor_at, second_factor_method)
     values ($1,$2,$3, clock_timestamp() + interval '30 minutes', clock_timestamp() + interval '8 hours', ${secondFactor ? 'clock_timestamp()' : 'null'}, ${secondFactor ? `'EMAIL_CODE'` : 'null'})`,
    [id, randomBytes(32), userId]);
  return id;
}
type Ch = { id?: string; userId: string; purpose: string; sessionId?: string | null; tokenHash?: Buffer | null; pendingEmail?: string | null; ttl?: string };
async function insertChallenge(c: Ch) {
  const id = c.id ?? uuidv7();
  await app.query(
    `insert into app.auth_challenges (id, user_id, purpose, session_id, token_hash, code_hmac, pending_email, expires_at)
     values ($1,$2,$3::app.challenge_purpose,$4,$5,$6,$7, clock_timestamp() + interval '${c.ttl ?? '10 minutes'}')`,
    [id, c.userId, c.purpose, c.sessionId ?? null, c.tokenHash === undefined ? randomBytes(32) : c.tokenHash, randomBytes(32), c.pendingEmail ?? null]);
  return id;
}

describe('auth_challenges (§ 3.3, R2)', () => {
  it('LOGIN : jeton obligatoire, aucune session', async () => {
    const u = await insertUser('l1@example.com');
    await expect(insertChallenge({ userId: u, purpose: 'LOGIN', tokenHash: null })).rejects.toMatchObject({ constraint: 'auth_challenges_shape' });
    await insertChallenge({ userId: u, purpose: 'LOGIN' });
  });
  it('STEP_UP : session obligatoire, jeton absent', async () => {
    const u = await insertUser('s1@example.com');
    await expect(insertChallenge({ userId: u, purpose: 'STEP_UP', tokenHash: null })).rejects.toMatchObject({ constraint: 'auth_challenges_shape' });
    await insertChallenge({ userId: u, purpose: 'STEP_UP', tokenHash: null, sessionId: await insertSession(u) });
  });
  it('une seule vérification active par usage, plusieurs usages possibles', async () => {
    const u = await insertUser('u1@example.com');
    await insertChallenge({ userId: u, purpose: 'LOGIN' });
    await expect(insertChallenge({ userId: u, purpose: 'LOGIN' })).rejects.toMatchObject({ code: '23505' });
    await insertChallenge({ userId: u, purpose: 'STEP_UP', tokenHash: null, sessionId: await insertSession(u) });
  });
  it('consommer libère l’usage ; consommation et motif vont ensemble ; une consommation est définitive', async () => {
    const u = await insertUser('c1@example.com');
    const id = await insertChallenge({ userId: u, purpose: 'LOGIN' });
    await expect(app.query(`update app.auth_challenges set consumed_at = clock_timestamp() where id = $1`, [id])).rejects.toMatchObject({ constraint: 'auth_challenges_consumed' });
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'SUPERSEDED' where id = $1`, [id]);
    await expect(app.query(`update app.auth_challenges set attempts = 1 where id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    await insertChallenge({ userId: u, purpose: 'LOGIN' });
  });
  it('au plus 5 essais, et le compteur ne baisse jamais', async () => {
    const u = await insertUser('a1@example.com');
    const id = await insertChallenge({ userId: u, purpose: 'LOGIN' });
    await app.query(`update app.auth_challenges set attempts = 3 where id = $1`, [id]);
    await expect(app.query(`update app.auth_challenges set attempts = 2 where id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    await expect(app.query(`update app.auth_challenges set attempts = 6 where id = $1`, [id])).rejects.toMatchObject({ constraint: 'auth_challenges_attempts_range' });
  });
  it('seul cp_privileged crée une vérification RECOVERY', async () => {
    const u = await insertUser('r1@example.com');
    await expect(insertChallenge({ userId: u, purpose: 'RECOVERY', tokenHash: null })).rejects.toMatchObject({ code: '42501' });
  });
  it('réservée aux administrateurs actifs', async () => {
    const u = await insertUser('stu@example.com', 'USER');
    await expect(insertChallenge({ userId: u, purpose: 'LOGIN' })).rejects.toMatchObject({ code: '23514' });
  });
  it('un compte bloqué ne reçoit plus de vérification (hors RECOVERY)', async () => {
    const u = await insertUser('b1@example.com');
    await app.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [u]);
    await expect(insertChallenge({ userId: u, purpose: 'LOGIN' })).rejects.toMatchObject({ code: '23514' });
  });
  it('EMAIL_CHANGE_NEW exige un EMAIL_CHANGE_OLD consommé (USED) de la même session et du même email', async () => {
    const u = await insertUser('e1@example.com');
    const s = await insertSession(u);
    await expect(insertChallenge({ userId: u, purpose: 'EMAIL_CHANGE_NEW', tokenHash: null, sessionId: s, pendingEmail: 'n@example.com' })).rejects.toMatchObject({ code: '23514' });
    const old = await insertChallenge({ userId: u, purpose: 'EMAIL_CHANGE_OLD', tokenHash: null, sessionId: s, pendingEmail: 'n@example.com' });
    await expect(insertChallenge({ userId: u, purpose: 'EMAIL_CHANGE_NEW', tokenHash: null, sessionId: s, pendingEmail: 'n@example.com' })).rejects.toMatchObject({ code: '23514' }); // OLD pas encore consommé
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [old]);
    await expect(insertChallenge({ userId: u, purpose: 'EMAIL_CHANGE_NEW', tokenHash: null, sessionId: s, pendingEmail: 'autre@example.com' })).rejects.toMatchObject({ code: '23514' }); // autre email
    await insertChallenge({ userId: u, purpose: 'EMAIL_CHANGE_NEW', tokenHash: null, sessionId: s, pendingEmail: 'n@example.com' });
  });
  it('cp_app ne supprime rien', async () => {
    const u = await insertUser('d1@example.com');
    const id = await insertChallenge({ userId: u, purpose: 'LOGIN' });
    await expect(app.query('delete from app.auth_challenges where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('colonnes de users (R3)', () => {
  it('cp_app pose le blocage mais ne le lève ni ne le modifie', async () => {
    const u = await insertUser('blk@example.com');
    await app.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [u]);
    await expect(app.query(`update app.users set second_factor_blocked_at = null where id = $1`, [u])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [u])).rejects.toMatchObject({ code: '23514' });
  });
  it('le blocage ne vise qu’un administrateur', async () => {
    const u = await insertUser('blk2@example.com', 'USER');
    await expect(app.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [u])).rejects.toMatchObject({ code: '23514' });
  });
  it('cp_app change l’email d’un administrateur, pas celui d’un étudiant', async () => {
    const a = await insertUser('adm@example.com');
    const s = await insertUser('stud@example.com', 'USER');
    await app.query(`update app.users set email = 'adm2@example.com' where id = $1`, [a]);
    await expect(app.query(`update app.users set email = 'stud2@example.com' where id = $1`, [s])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.users set global_role = 'USER' where id = $1`, [a])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('sessions : second facteur (§ 3.3)', () => {
  it('une session d’administrateur sans second facteur est refusée', async () => {
    const a = await insertUser('sa@example.com');
    await expect(insertSession(a, false)).rejects.toMatchObject({ code: '23514' });
    await insertSession(a, true);
  });
  it('une session d’étudiant n’en a pas besoin ; méthode et date vont ensemble', async () => {
    const s = await insertUser('ss@example.com', 'USER');
    await insertSession(s, false);
    await expect(app.query(`insert into app.sessions (id, token_hash, user_id, idle_expires_at, absolute_expires_at, second_factor_method) values ($1,$2,$3, now() + interval '1 hour', now() + interval '2 hours', 'EMAIL_CODE')`, [uuidv7(), randomBytes(32), s])).rejects.toMatchObject({ constraint: 'sessions_second_factor_pair' });
  });
  it('cp_app met à jour step_up_at', async () => {
    const a = await insertUser('su@example.com');
    const id = await insertSession(a);
    await app.query(`update app.sessions set step_up_at = clock_timestamp() where id = $1`, [id]);
    await expect(app.query(`update app.sessions set second_factor_at = null, second_factor_method = null where id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('second_factor_failures, password_reset_tokens, seaux', () => {
  it('failures : insertion et lecture seulement', async () => {
    const u = await insertUser('f1@example.com');
    await app.query(`insert into app.second_factor_failures (user_id, challenge_id, purpose) values ($1, $2, 'LOGIN')`, [u, uuidv7()]);
    await expect(app.query('delete from app.second_factor_failures where user_id = $1', [u])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.second_factor_failures set purpose = 'STEP_UP' where user_id = $1`, [u])).rejects.toMatchObject({ code: '42501' });
  });
  it('jetons de réinitialisation : un seul actif par compte, hachage de 32 octets', async () => {
    const u = await insertUser('p1@example.com');
    const ins = (hash: Buffer) => app.query(`insert into app.password_reset_tokens (id, user_id, token_hash, expires_at) values ($1,$2,$3, clock_timestamp() + interval '30 minutes')`, [uuidv7(), u, hash]);
    await expect(ins(randomBytes(16))).rejects.toMatchObject({ constraint: 'password_reset_hash_len' });
    await ins(randomBytes(32));
    await expect(ins(randomBytes(32))).rejects.toMatchObject({ code: '23505' });
    await app.query(`update app.password_reset_tokens set consumed_at = clock_timestamp() where user_id = $1`, [u]);
    await ins(randomBytes(32));
  });
  it.each(['otp-ip:203.0.113.7', 'otp-try-ip:2001:db8:1:2::', 'forgot-ip:203.0.113.7', `forgot-acct:${'a'.repeat(64)}`])('seau accepté %s', async (key) => {
    await app.query('insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp())', [key]);
  });
  it.each(['otp-ip:', 'forgot-acct:alice@example.com', 'login:1.2.3.4'])('seau refusé %s', async (key) => {
    await expect(app.query('insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp())', [key])).rejects.toMatchObject({ constraint: 'rate_limit_key_shape' });
  });
});
