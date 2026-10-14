import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAdminRecoveryCode, type RecoveryIo } from '../../src/ops/admin-recovery-code.js';
import { otpHmac } from '../../src/modules/auth/second-factor/otp.js';
import { TEST_OTP_PEPPER, buildTestApp, cookieHeader, runOps, send, sessionCookieOf, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { createAdmin } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let ops: pg.Client;
beforeAll(async () => { db = await createTestDatabase(); t = await buildTestApp(db); ops = await connectAs('cp_ops', db); });
afterAll(async () => { await ops.end(); await t.close(); });

const CODE_RE = /: ([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})\n/;
function fakeIo(over: Partial<RecoveryIo> = {}) {
  const written: string[] = [];
  const io: RecoveryIo = { isTty: true, write: (s) => { written.push(s); }, waitForEnter: async () => undefined, ...over };
  return { io, written, text: () => written.join('') };
}
async function issue(email: string, clearBlock = false) {
  const f = fakeIo();
  const exit = await runAdminRecoveryCode({ client: ops, pepper: TEST_OTP_PEPPER, io: f.io }, { email, clearBlock });
  return { exit, code: CODE_RE.exec(f.text())?.[1], text: f.text() };
}
async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const cookies = (res: { headers: Record<string, unknown> }) => [res.headers['set-cookie']].flat().filter((c): c is string => typeof c === 'string');
async function loginCookie(a: { email: string; password: string }) {
  const res = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password });
  return { cookie: `__Host-cp_challenge=${/__Host-cp_challenge=([^;]+)/.exec(cookies(res).find((c) => c.startsWith('__Host-cp_challenge='))!)![1]}` };
}
async function block(userId: string) {
  const c = await connectAs('cp_app', db);
  await c.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [userId]);
  await c.end();
}
const isBlocked = async (userId: string) => (await rows(`select second_factor_blocked_at is not null as b from app.users where id = $1`, [userId]))[0].b as boolean;

describe('priv.issue_admin_recovery_code via runAdminRecoveryCode', () => {
  it('émet un code de 12 caractères : seul le HMAC est en base, audit PRIVILEGED sous cp_ops, alertes à tous les administrateurs', async () => {
    const a = await createAdmin(db);
    const other = await createAdmin(db);
    const { exit, code, text } = await issue(a.email);
    expect(exit).toBe(0);
    expect(code).toBeTruthy();
    expect(text).toContain('15 minutes');
    const [ch] = await rows(`select id, code_hmac, token_hash, session_id, expires_at > clock_timestamp() + interval '14 minutes' as fifteen from app.auth_challenges where user_id = $1 and purpose = 'RECOVERY' and consumed_at is null`, [a.id]);
    expect(ch.code_hmac.equals(otpHmac(TEST_OTP_PEPPER, ch.id, code!.replaceAll('-', '')))).toBe(true);
    expect([ch.token_hash, ch.session_id, ch.fifteen]).toEqual([null, null, true]);
    const [audit] = await rows(`select source, db_login_role, action, actor_user_id from app.audit_log where target_id = $1 and action = 'ADMIN_RECOVERY_CODE_ISSUED'`, [a.id]);
    expect(audit).toEqual({ source: 'PRIVILEGED', db_login_role: 'cp_ops', action: 'ADMIN_RECOVERY_CODE_ISSUED', actor_user_id: null });
    const alerts = await rows(`select recipient_user_id, payload from app.email_outbox where kind = 'ADMIN_SECURITY_ALERT' and payload->>'event' = 'RECOVERY_CODE_ISSUED' and payload->>'accountEmail' = $1`, [a.email]);
    expect(alerts.map((r) => r.recipient_user_id)).toEqual(expect.arrayContaining([a.id, other.id]));
    // le code n'apparaît dans aucune colonne
    const bare = code!.replaceAll('-', '');
    const dump = JSON.stringify(await rows(`select payload, to_address from app.email_outbox`)) + JSON.stringify(await rows(`select metadata from app.audit_log`));
    expect(dump).not.toContain(bare);
  });
  it('un nouveau code remplace le précédent (SUPERSEDED)', async () => {
    const a = await createAdmin(db);
    await issue(a.email);
    await issue(a.email);
    const r = await rows(`select consumed_reason from app.auth_challenges where user_id = $1 and purpose = 'RECOVERY' order by created_at`, [a.id]);
    expect(r.map((x) => x.consumed_reason)).toEqual(['SUPERSEDED', null]);
  });
  it.each(['inconnu@example.com'])('cible inconnue : TARGET_NOT_ACTIVE_ADMIN, aucun code affiché', async (email) => {
    const { exit, code, text } = await issue(email);
    expect([exit, code]).toEqual([1, undefined]);
    expect(text).toContain('TARGET_NOT_ACTIVE_ADMIN');
  });
  it('un compte suspendu n’est pas une cible valable', async () => {
    const s = await createAdmin(db, { status: 'SUSPENDED' });
    const { exit, text } = await issue(s.email);
    expect(exit).toBe(1);
    expect(text).toContain('TARGET_NOT_ACTIVE_ADMIN');
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1`, [s.id])).toHaveLength(0);
  });
  it('compte bloqué sans --clear-block : TARGET_BLOCKED, aucune vérification, aucun email, aucun audit, blocage conservé', async () => {
    const a = await createAdmin(db);
    await block(a.id);
    const { exit, code, text } = await issue(a.email);
    expect([exit, code]).toEqual([1, undefined]);
    expect(text).toContain('compte bloqué : relancer avec --clear-block');
    expect(await isBlocked(a.id)).toBe(true);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1`, [a.id])).toHaveLength(0);
    expect(await rows(`select 1 from app.email_outbox where payload->>'accountEmail' = $1`, [a.email])).toHaveLength(0);
    expect(await rows(`select 1 from app.audit_log where target_id = $1 and action in ('ADMIN_RECOVERY_CODE_ISSUED', 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED')`, [a.id])).toHaveLength(0);
  });
  it('--clear-block lève le blocage (audit PRIVILEGED) et émet le code', async () => {
    const a = await createAdmin(db);
    await block(a.id);
    const { exit, code } = await issue(a.email, true);
    expect([exit, typeof code]).toEqual([0, 'string']);
    expect(await isBlocked(a.id)).toBe(false);
    expect((await rows(`select source, db_login_role from app.audit_log where target_id = $1 and action = 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED'`, [a.id]))[0]).toEqual({ source: 'PRIVILEGED', db_login_role: 'cp_ops' });
  });
  it('garde-fou : sans terminal, aucune requête n’est envoyée et aucun code n’est affiché', async () => {
    let queries = 0;
    const f = fakeIo({ isTty: false });
    const exit = await runAdminRecoveryCode({ client: { query: (async () => { queries++; return { rows: [] }; }) as never }, pepper: TEST_OTP_PEPPER, io: f.io }, { email: 'a@example.com', clearBlock: false });
    expect([exit, queries]).toEqual([2, 0]);
    expect(f.text()).toContain('TTY_REQUIRED');
  });
  it('le code n’est affiché qu’après la validation : si la base échoue, rien n’est affiché ni détaillé', async () => {
    const f = fakeIo();
    const exit = await runAdminRecoveryCode({ client: { query: (async () => { throw Object.assign(new Error('secret détail interne'), { code: 'XX000' }); }) as never }, pepper: TEST_OTP_PEPPER, io: f.io }, { email: 'a@example.com', clearBlock: false });
    expect(exit).toBe(1);
    expect(f.text()).toContain('UNEXPECTED');
    expect(f.text()).not.toContain('secret détail interne');
    expect(f.text()).not.toMatch(CODE_RE);
  });
  it('affiche le code, attend Entrée, puis efface l’écran', async () => {
    const a = await createAdmin(db);
    const seen: string[] = [];
    const f = fakeIo({ waitForEnter: async () => { seen.push('enter'); } });
    await runAdminRecoveryCode({ client: ops, pepper: TEST_OTP_PEPPER, io: f.io }, { email: a.email, clearBlock: false });
    expect(f.written.at(-1)).toBe('\x1b[2J\x1b[3J\x1b[H');
    expect(seen).toEqual(['enter']);
  });
  it('le texte SQL est une constante (aucune concaténation) et le fichier n’utilise ni Prisma ni Nest', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../src/ops/admin-recovery-code.ts'), 'utf8');
    expect(src).toMatch(/client\.query\(\s*'select priv\.issue_admin_recovery_code\(\$1, \$2, \$3, \$4\)/);
    expect(src).not.toMatch(/prisma|@nestjs|console\.log|logger/i);
  });
  it('cp_app ne peut ni appeler la fonction ni créer une vérification RECOVERY', async () => {
    const a = await createAdmin(db);
    const c = await connectAs('cp_app', db);
    await expect(c.query(`select priv.issue_admin_recovery_code($1, gen_random_uuid(), decode(repeat('00', 32), 'hex'), false)`, [a.email])).rejects.toMatchObject({ code: '42501' });
    await c.end();
  });
  it('processus séparé sans terminal : refusé (code 2, TTY_REQUIRED), aucune vérification créée', async () => {
    const a = await createAdmin(db);
    const r = await runOps(db, ['admin-recovery-code', '--email', a.email]);
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toContain('TTY_REQUIRED');
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1`, [a.id])).toHaveLength(0);
  }, 60_000);
});

describe('POST /api/auth/verify-recovery', () => {
  it('avec le cookie LOGIN et le code de récupération : session ouverte, les deux vérifications consommées, audit', async () => {
    const a = await createAdmin(db);
    const header = await loginCookie(a);
    const { code } = await issue(a.email);
    const res = await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: code!.toLowerCase() }, header); // casse et tirets ignorés
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: a.id, globalRole: 'ADMIN' });
    expect(cookies(res)).toContain('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    expect((await send(t.app, 'GET', '/api/me', undefined, cookieHeader(sessionCookieOf(res)!))).statusCode).toBe(200);
    expect((await rows(`select second_factor_method as m from app.sessions where user_id = $1`, [a.id]))[0].m).toBe('RECOVERY_CODE');
    expect((await rows(`select purpose::text as p, consumed_reason::text as r from app.auth_challenges where user_id = $1 order by purpose`, [a.id])).map((r) => `${r.p}:${r.r}`)).toEqual(['LOGIN:USED', 'RECOVERY:USED']);
    expect((await rows(`select metadata from app.audit_log where target_id = $1 and action = 'ADMIN_LOGIN'`, [a.id]))[0].metadata).toEqual({ method: 'RECOVERY_CODE' });
  });
  it('sans cookie LOGIN, le code de récupération ne sert à rien (seulement après le mot de passe)', async () => {
    const a = await createAdmin(db);
    const { code } = await issue(a.email);
    const res = await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: code! });
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('le cookie LOGIN d’un autre administrateur ne sert pas', async () => {
    const a = await createAdmin(db);
    const b = await createAdmin(db);
    const headerB = await loginCookie(b);
    const { code } = await issue(a.email);
    const res = await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: code! }, headerB);
    expect(res.json().error.code).toBe('CHALLENGE_EXPIRED'); // b n'a aucune vérification RECOVERY active
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('mauvais code : CODE_INVALID, essais comptés sur la vérification RECOVERY, échecs enregistrés', async () => {
    const a = await createAdmin(db);
    const header = await loginCookie(a);
    const { code } = await issue(a.email);
    const wrong = code!.startsWith('A') ? 'BBBB-BBBB-BBBB' : 'AAAA-AAAA-AAAA';
    const res = await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: wrong }, header);
    expect([res.statusCode, res.json().error.code, res.json().error.attemptsLeft]).toEqual([400, 'CODE_INVALID', 4]);
    expect((await rows(`select attempts from app.auth_challenges where user_id = $1 and purpose = 'RECOVERY'`, [a.id]))[0].attempts).toBe(1);
    expect(await rows(`select 1 from app.second_factor_failures where user_id = $1 and purpose = 'RECOVERY'`, [a.id])).toHaveLength(1);
  });
  it('compte bloqué après l’émission : le code est refusé sans comparaison ; après --clear-block un nouveau code fonctionne', async () => {
    const a = await createAdmin(db);
    const header = await loginCookie(a);
    const first = await issue(a.email); // émis avant le blocage
    await block(a.id);
    const refused = await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: first.code! }, header);
    expect([refused.statusCode, refused.json().error.code]).toEqual([403, 'SECOND_FACTOR_BLOCKED']);
    expect((await rows(`select attempts from app.auth_challenges where user_id = $1 and purpose = 'RECOVERY' and consumed_at is null`, [a.id]))[0].attempts).toBe(0);
    expect((await issue(a.email)).exit).toBe(1); // sans --clear-block : rien de nouveau
    const second = await issue(a.email, true);
    expect((await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: second.code! }, header)).statusCode).toBe(200);
  });
  it('deux requêtes simultanées avec le bon code : une session, une erreur (ordre de verrous LOGIN puis RECOVERY)', async () => {
    const a = await createAdmin(db);
    const header = await loginCookie(a);
    const { code } = await issue(a.email);
    const res = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: code! }, header)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(1);
  });
  it('un titulaire qui a consommé la vérification LOGIN : la récupération reçoit CHALLENGE_EXPIRED (verrou observé)', async () => {
    const a = await createAdmin(db);
    const header = await loginCookie(a);
    const { code } = await issue(a.email);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [a.id]);
    await holder.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where user_id = $1 and purpose = 'LOGIN'`, [a.id]);
    const pending = send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: code! }, header);
    await waitForLockWait(db, pid);
    await holder.query('commit');
    await holder.end();
    expect((await pending).json().error.code).toBe('CHALLENGE_EXPIRED');
  });
});
