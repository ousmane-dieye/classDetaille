import { createHash } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_ROW_CAP } from '../../src/modules/auth/login-rate-limiter.js';
import { buildTestApp, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { cipher } from '../support/mail.js';
import { ageChallenges, createAdmin, loginAdmin } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let classId: string;
beforeAll(async () => { db = await createTestDatabase(); t = await buildTestApp(db); classId = await insertClass(db, 'L3 Reset'); });
afterAll(async () => { await t.close(); });

const NEW_PASSWORD = 'un tout nouveau mot de passe 2026';
async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const forgot = (email: string, ip?: string) => send(t.app, 'POST', '/api/auth/forgot-password', { email, turnstileToken: 'tok' }, {}, ip);
/** Le jeton en clair de la dernière demande (déchiffré avec la clé de test) : remplace la boîte email. */
async function latestToken(email: string): Promise<string> {
  const [r] = await rows(`select id, payload_encrypted from app.email_outbox where to_address = $1 and kind = 'PASSWORD_RESET' and payload_encrypted is not null order by created_at desc, id desc limit 1`, [email]);
  return cipher.decrypt(r.id, r.payload_encrypted).token!;
}
const reset = (token: string, newPassword = NEW_PASSWORD) => send(t.app, 'POST', '/api/auth/reset-password', { token, newPassword });

describe('POST /api/auth/forgot-password', () => {
  it('compte actif, inconnu, suspendu : la même réponse 202 ; seul le compte actif reçoit un email (Review Focus 5)', async () => {
    const s = await registerStudent(t.app, classId);
    const susp = await createAdmin(db, { status: 'SUSPENDED' });
    const r1 = await forgot(s.email);
    const r2 = await forgot('inconnu.reset@example.com');
    const r3 = await forgot(susp.email);
    for (const r of [r1, r2, r3]) { expect(r.statusCode).toBe(202); expect(r.json()).toEqual({ status: 'RESET_REQUESTED' }); expect(r.headers['referrer-policy']).toBe('no-referrer'); }
    expect(await rows(`select 1 from app.email_outbox where kind = 'PASSWORD_RESET' and to_address = $1`, [s.email])).toHaveLength(1);
    expect(await rows(`select 1 from app.email_outbox where kind = 'PASSWORD_RESET' and to_address in ($1, $2)`, ['inconnu.reset@example.com', susp.email])).toHaveLength(0);
  });
  it('jeton de 32 octets, haché (SHA-256), valable 30 min, absent de payload ; expiration de l’email alignée', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await rows(`select token_hash, extract(epoch from expires_at - created_at)::int as ttl from app.password_reset_tokens where user_id = $1 and consumed_at is null`, [s.userId]);
    expect(row.token_hash.equals(createHash('sha256').update(Buffer.from(token, 'base64url')).digest())).toBe(true);
    expect(row.ttl).toBeGreaterThanOrEqual(1799); expect(row.ttl).toBeLessThanOrEqual(1801);
    expect(JSON.stringify(await rows(`select payload from app.email_outbox where kind = 'PASSWORD_RESET' and to_address = $1`, [s.email]))).not.toContain(token);
  });
  it('Turnstile invalide : 400 ; indisponible : 503 RESET_UNAVAILABLE avec Retry-After ; aucun jeton créé', async () => {
    const s = await registerStudent(t.app, classId);
    t.turnstile.next = 'invalid';
    expect((await forgot(s.email)).json().error.code).toBe('TURNSTILE_FAILED');
    t.turnstile.next = 'error';
    const down = await forgot(s.email);
    expect([down.statusCode, down.json().error.code, down.headers['retry-after']]).toEqual([503, 'RESET_UNAVAILABLE', '60']);
    t.turnstile.next = 'valid';
    expect(await rows(`select 1 from app.password_reset_tokens where user_id = $1`, [s.userId])).toHaveLength(0);
  });
  it('une nouvelle demande annule la précédente ; au-delà de 3 par heure et par compte : même 202, aucun email (R9)', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const first = await latestToken(s.email);
    await forgot(s.email);
    const second = await latestToken(s.email);
    expect(second).not.toBe(first);
    expect((await reset(first)).json().error.code).toBe('RESET_TOKEN_INVALID');
    await forgot(s.email); // 3ᵉ
    const fourth = await forgot(s.email);
    expect([fourth.statusCode, fourth.json()]).toEqual([202, { status: 'RESET_REQUESTED' }]);
    expect(await rows(`select 1 from app.email_outbox where kind = 'PASSWORD_RESET' and to_address = $1`, [s.email])).toHaveLength(3);
  });
  it('une nouvelle demande annule aussi l’email non parti de la précédente : un lien mort n’est jamais envoyé (F5)', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    await forgot(s.email);
    const r = await rows(`select status::text as status, payload_encrypted is null as erased from app.email_outbox where kind = 'PASSWORD_RESET' and to_address = $1 order by created_at, id`, [s.email]);
    expect(r).toEqual([{ status: 'CANCELLED', erased: true }, { status: 'PENDING', erased: false }]);
  });
  it('D13 : au-delà du plafond de lignes, la limite par IP reste appliquée, celle par compte est suspendue', async () => {
    await rows(`insert into app.rate_limit_buckets (key, window_start) select 'ip:10.' || (g / 65536) || '.' || ((g / 256) % 256) || '.' || (g % 256), clock_timestamp() from generate_series(1, $1::int) g`, [BUCKET_ROW_CAP + 1]);
    try {
      const s = await registerStudent(t.app, classId);
      const ip = '198.51.100.99';
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await forgot(s.email, ip)).statusCode); // 4 > 3 par compte : toutes servies
      for (let i = 0; i < 7; i++) codes.push((await forgot(`d13.${i}@example.com`, ip)).statusCode);
      expect(codes).toEqual([...Array(10).fill(202), 429]);
      expect(await rows(`select 1 from app.email_outbox where kind = 'PASSWORD_RESET' and to_address = $1`, [s.email])).toHaveLength(4);
    } finally {
      await rows(`delete from app.rate_limit_buckets where key like 'ip:10.%'`);
    }
  });
  it('10 demandes par heure et par IP, puis 429', async () => {
    const ip = '198.51.100.88';
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await forgot(`ip.${i}@example.com`, ip)).statusCode;
    expect(last).toBe(429);
  });
});

describe('POST /api/auth/reset-password', () => {
  it('nouveau mot de passe, toutes les sessions révoquées, jeton consommé, audit, alerte ; l’ancien mot de passe ne marche plus', async () => {
    const s = await registerStudent(t.app, classId);
    await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: s.password }); // deuxième session
    await forgot(s.email);
    const token = await latestToken(s.email);
    const res = await reset(token);
    expect(res.statusCode).toBe(204);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect((await rows(`select count(*)::int as n from app.sessions where user_id = $1 and revoked_at is null`, [s.userId]))[0].n).toBe(0);
    expect((await rows(`select distinct revoke_reason::text as r from app.sessions where user_id = $1`, [s.userId]))[0].r).toBe('PASSWORD_CHANGED');
    expect((await rows(`select metadata from app.audit_log where target_id = $1 and action = 'PASSWORD_RESET_COMPLETED'`, [s.userId]))[0].metadata).toEqual({ revokedSessions: 2 });
    expect((await rows(`select 1 from app.email_outbox where kind = 'SECURITY_ALERT' and to_address = $1 and payload->>'event' = 'PASSWORD_RESET'`, [s.email])).length).toBe(1);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: s.password })).statusCode).toBe(401);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: NEW_PASSWORD })).statusCode).toBe(200);
    const again = await reset(token); // usage unique
    expect([again.statusCode, again.json().error.code]).toEqual([400, 'RESET_TOKEN_INVALID']);
  });
  it('jeton inconnu, mal formé ou expiré', async () => {
    expect((await reset('A'.repeat(43))).json().error.code).toBe('RESET_TOKEN_INVALID');
    expect((await reset('court')).json().error.code).toBe('VALIDATION_FAILED');
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    const o = await connectAs('cp_owner', db);
    await o.query(`update app.password_reset_tokens set expires_at = clock_timestamp() - interval '1 second' where user_id = $1`, [s.userId]);
    await o.end();
    expect((await reset(token)).json().error.code).toBe('RESET_TOKEN_INVALID');
  });
  it('mot de passe refusé par la politique : l’erreur précise, et le jeton reste utilisable', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    const short = await reset(token, 'trop court');
    expect([short.statusCode, short.json().error.code]).toEqual([400, 'PASSWORD_TOO_SHORT']);
    expect((await reset(token)).statusCode).toBe(204);
  });
  it('compte suspendu entre la demande et la réinitialisation : RESET_TOKEN_INVALID', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    const o = await connectAs('cp_owner', db);
    await o.query(`update app.users set status = 'SUSPENDED' where id = $1`, [s.userId]);
    await o.end();
    expect((await reset(token)).json().error.code).toBe('RESET_TOKEN_INVALID');
  });
  it('administrateur : mot de passe de 16 caractères au moins ; après la réinitialisation, le code reste exigé à la connexion et les vérifications en cours sont terminées', async () => {
    const a = await loginAdmin(t.app, db);
    await ageChallenges(db, a.admin.id, 2);
    await send(t.app, 'POST', '/api/me/step-up', { password: a.admin.password }, a.headers);
    await forgot(a.admin.email);
    const token = await latestToken(a.admin.email);
    const short = await reset(token, 'quinze caracter');
    expect([short.statusCode, short.json().error.code]).toEqual([400, 'PASSWORD_TOO_SHORT']);
    expect((await reset(token)).statusCode).toBe(204);
    expect((await rows(`select count(*)::int as n from app.auth_challenges where user_id = $1 and consumed_at is null`, [a.admin.id]))[0].n).toBe(0);
    expect((await send(t.app, 'GET', '/api/me', undefined, a.headers)).statusCode).toBe(401);
    await ageChallenges(db, a.admin.id, 2); // la limite d'une demande de code par minute porterait sur l'étape de ressaisie ci-dessus
    expect((await send(t.app, 'POST', '/api/auth/login', { email: a.admin.email, password: NEW_PASSWORD })).statusCode).toBe(202);
  });
  it('deux réinitialisations simultanées avec le même jeton : une seule aboutit', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    const res = await Promise.all([reset(token, NEW_PASSWORD), reset(token, `${NEW_PASSWORD} bis`)]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([204, 400]);
  });
  async function holdThenReset(outcome: 'COMMIT' | 'ROLLBACK') {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [s.userId]);
    await holder.query(`update app.password_reset_tokens set consumed_at = clock_timestamp() where user_id = $1 and consumed_at is null`, [s.userId]);
    const pending = reset(token);
    await waitForLockWait(db, pid);
    await holder.query(outcome);
    await holder.end();
    return pending;
  }
  it('le titulaire a consommé le jeton (verrou observé) : RESET_TOKEN_INVALID', async () => {
    const r = await holdThenReset('COMMIT');
    expect([r.statusCode, r.json().error.code]).toEqual([400, 'RESET_TOKEN_INVALID']);
  });
  it('le titulaire a annulé (verrou observé) : la réinitialisation aboutit', async () => {
    expect((await holdThenReset('ROLLBACK')).statusCode).toBe(204);
  });
});
