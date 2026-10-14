import 'reflect-metadata';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_METADATA } from '../../src/modules/audit/audit-actions.js';
import { EMAIL_KINDS, SECURITY_KINDS } from '../../src/modules/mail/email-kinds.js';
import { TEST_OTP_PEPPER, TEST_OUTBOX_KEY, buildTestApp, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { cipher, seedChallengeEmail, SYSTEM } from '../support/mail.js';
import { ageChallenges, createAdmin, latestCode } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
const logged: string[] = [];
beforeAll(async () => {
  db = await createTestDatabase();
  const sink = new Writable({ write(chunk, _enc, cb) { logged.push(String(chunk)); cb(); } });
  t = await buildTestApp(db, { logStream: sink });
});
afterAll(async () => { await t.close(); });
async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const setCookies = (res: { headers: Record<string, unknown> }) => [res.headers['set-cookie']].flat().filter((c): c is string => typeof c === 'string');

describe('aucun secret dans les journaux, les métadonnées d’audit ni les colonnes en clair', () => {
  it('codes, jetons, cookies, HMAC et clés ne figurent nulle part après un parcours complet', async () => {
    const secrets: string[] = [TEST_OTP_PEPPER, TEST_OUTBOX_KEY.toString('hex')];
    const a = await createAdmin(db);
    const login = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password });
    const challengeToken = /__Host-cp_challenge=([^;]+)/.exec(setCookies(login)[0]!)![1]!;
    const code = await latestCode(db, a.email);
    secrets.push(code, challengeToken);
    const verified = await send(t.app, 'POST', '/api/auth/verify-code', { code }, { cookie: `__Host-cp_challenge=${challengeToken}` });
    const session = /__Host-cp_session=([^;]+)/.exec(setCookies(verified).find((c) => c.startsWith('__Host-cp_session='))!)![1]!;
    secrets.push(session);
    await send(t.app, 'POST', '/api/auth/verify-code', { code: '999999' }, { cookie: `__Host-cp_challenge=${challengeToken}` });
    // réinitialisation de mot de passe
    const classId = await insertClass(db, 'L3 Security Admin');
    const s = await registerStudent(t.app, classId);
    await send(t.app, 'POST', '/api/auth/forgot-password', { email: s.email, turnstileToken: 'tok' });
    const [mail] = await rows(`select id, payload_encrypted from app.email_outbox where kind = 'PASSWORD_RESET' and to_address = $1`, [s.email]);
    const resetToken = cipher.decrypt(mail.id, mail.payload_encrypted).token!;
    secrets.push(resetToken);
    await send(t.app, 'POST', '/api/auth/reset-password', { token: resetToken, newPassword: 'un tout nouveau mot de passe 2026' });
    // ce que la base garde en clair
    const [ch] = await rows(`select encode(code_hmac, 'hex') as h from app.auth_challenges where user_id = $1 limit 1`, [a.id]);
    secrets.push(ch.h);
    const visible = [
      logged.join('\n'),
      JSON.stringify(await rows('select metadata from app.audit_log')),
      JSON.stringify(await rows('select payload, to_address, dedupe_key, message_id from app.email_outbox')),
      JSON.stringify(await rows('select smtp_response, error_code from app.email_attempts')),
    ].join('\n');
    // les codes à 6 chiffres sont cherchés entre non-chiffres (horodatages et identifiants contiennent des suites de chiffres)
    for (const secret of secrets) {
      if (/^\d{6}$/.test(secret)) expect(new RegExp(`(?<![0-9])${secret}(?![0-9])`).test(visible), `fuite d’un code`).toBe(false);
      else expect(visible, `fuite de ${secret.slice(0, 4)}…`).not.toContain(secret);
    }
  });
  it('les journaux du worker ne contiennent ni adresse ni contenu', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation((msg: unknown) => { lines.push(String(msg)); }));
    let seeded: Awaited<ReturnType<typeof seedChallengeEmail>>;
    try {
    const { EmailSender } = await import('../../src/modules/mail/email-sender.js');
    const { MailWorkerModule } = await import('../../src/modules/mail/mail-worker.module.js');
    const { MailTransport } = await import('../../src/modules/mail/mail-transport.js');
    const { Test } = await import('@nestjs/testing');
    const { ConfigModule } = await import('../../src/config/config.module.js');
    const { DatabaseModule } = await import('../../src/database/database.module.js');
    const { AuthzModule } = await import('../../src/modules/authz/authz.module.js');
    const { testConfig, workerConfigFor } = await import('../support/app.js');
    class Accepting extends MailTransport { async send() { return { kind: 'ACCEPTED' as const, smtpCode: 250, response: '250 OK dest', errorCode: null }; } }
    const mod = await Test.createTestingModule({ imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, MailWorkerModule.register(workerConfigFor(db), new Accepting())] }).compile();
    await mod.init();
    seeded = await seedChallengeEmail(db, '424242');
    await mod.get(EmailSender).drain(SYSTEM, new AbortController().signal);
    await mod.close();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const all = lines.join('\n');
    expect(all).toContain(seeded!.emailId);
    expect(all).not.toContain(seeded!.email);
    expect(/(?<!\d)424242(?!\d)/.test(all)).toBe(false);
  });
  it('un email dans un état final n’a plus de contenu chiffré', async () => {
    expect((await rows(`select 1 from app.email_outbox where status in ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED')`)).length, 'au moins un email en état final').toBeGreaterThan(0);
    expect(await rows(`select 1 from app.email_outbox where status in ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED') and payload_encrypted is not null`)).toHaveLength(0);
  });
});

describe('cookies du lot 1b : attributs exacts', () => {
  it('session d’administrateur, vérification et effacement', async () => {
    const a = await createAdmin(db);
    const login = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password });
    const challenge = setCookies(login).find((c) => c.startsWith('__Host-cp_challenge='))!;
    expect(challenge).toMatch(/^__Host-cp_challenge=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=600$/);
    const res = await send(t.app, 'POST', '/api/auth/verify-code', { code: await latestCode(db, a.email) }, { cookie: challenge.split(';')[0]! });
    const cookies = setCookies(res);
    expect(cookies.find((c) => c.startsWith('__Host-cp_session='))).toMatch(/^__Host-cp_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800$/);
    expect(cookies).toContain('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    for (const c of cookies) expect(c).not.toMatch(/Domain=/i);
  });
});

describe('un administrateur n’obtient jamais de session sans code', () => {
  it('ni par la connexion, ni par le renvoi, ni avec un code de forme valide mais inconnu', async () => {
    const a = await createAdmin(db);
    const login = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password });
    expect(setCookies(login).some((c) => c.startsWith('__Host-cp_session='))).toBe(false);
    const header = { cookie: setCookies(login)[0]!.split(';')[0]! };
    await ageChallenges(db, a.id, 2);
    const resend = await send(t.app, 'POST', '/api/auth/resend-code', {}, header);
    expect(setCookies(resend).some((c) => c.startsWith('__Host-cp_session='))).toBe(false);
    expect((await send(t.app, 'POST', '/api/auth/verify-code', { code: '000000' }, { cookie: setCookies(resend)[0]!.split(';')[0]! })).statusCode).toBe(400);
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('« aucune option ne désactive la vérification » : le service d’emails n’a aucune influence sur l’accès', async () => {
    const a = await createAdmin(db);
    const login = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password });
    expect(login.statusCode).toBe(202);
    expect((await rows(`select status from app.email_outbox where recipient_user_id = $1`, [a.id]))[0].status).toBe('PENDING'); // aucun worker
    expect((await send(t.app, 'GET', '/api/me')).statusCode).toBe(401);
  });
});

describe('contrat avec le lot 1c : codes d’erreur stables (R4)', () => {
  it('l’ensemble des codes levés par les modules d’authentification est celui que le web traduira', () => {
    const dir = resolve(import.meta.dirname, '../../src/modules');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p); } };
    walk(resolve(dir, 'auth'));
    const found = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/(?:new ApiError\(\d{3}, |tooManyRequests\()'([A-Z_]+)'/g)) found.add(m[1]!);
    for (const m of readFileSync(resolve(dir, 'auth/second-factor/second-factor.service.ts'), 'utf8').matchAll(/(?:new ApiError\(\d{3}, |tooManyRequests\()'([A-Z_]+)'/g)) found.add(m[1]!);
    // le code TOO_MANY_ATTEMPTS est levé par l'assistant tooManyAttempts()
    if (files.some((f) => readFileSync(f, 'utf8').includes('throw tooManyAttempts('))) found.add('TOO_MANY_ATTEMPTS');
    expect([...found].sort()).toEqual([
      'CHALLENGE_EXPIRED', 'CODE_INVALID', 'CODE_LOCKED', 'CURRENT_PASSWORD_INVALID', 'EMAIL_TAKEN', 'EMAIL_UNCHANGED', 'INVALID_CREDENTIALS',
      'REAUTH_REQUIRED', 'RESET_TOKEN_INVALID', 'RESET_UNAVAILABLE', 'SECOND_FACTOR_BLOCKED', 'SIGNUP_UNAVAILABLE', 'STEP_UP_REQUIRED',
      'TOO_MANY_ATTEMPTS', 'TOO_MANY_CODE_REQUESTS', 'TURNSTILE_FAILED', 'TURNSTILE_REQUIRED', 'UNAUTHENTICATED', 'ACCOUNT_SUSPENDED',
    ].sort());
    // F3 : chaque code émis figure dans le tableau « Contrat pour le lot 1c » du README (et 403 FORBIDDEN, levé par l'autorisation).
    const readme = readFileSync(resolve(import.meta.dirname, '../../../../README.md'), 'utf8');
    const start = readme.indexOf('Contrat pour le lot 1c');
    const section = readme.slice(start, readme.indexOf('### Récupération', start));
    expect(start).toBeGreaterThan(0);
    for (const code of [...found, 'FORBIDDEN']) expect(section, code).toContain(code);
  });
});

describe('cohérence entre le code et la base', () => {
  it('chaque action d’audit de l’application existe dans l’énumération SQL, et aucune action privilégiée n’est déclarée côté application', async () => {
    const c = await connectAs('cp_app', db);
    const r = await c.query(`select unnest(enum_range(null::app.audit_action))::text as v`);
    await c.end();
    const sql = new Set(r.rows.map((x) => x.v as string));
    for (const action of Object.keys(AUDIT_METADATA)) expect(sql.has(action), action).toBe(true);
    for (const reserved of ['ACCOUNT_ANONYMIZED', 'ADMIN_RECOVERY_CODE_ISSUED', 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED', 'DATABASE_RESTORED']) expect(Object.keys(AUDIT_METADATA)).not.toContain(reserved);
  });
  it('les types d’email du code sont ceux de l’énumération SQL ; les types de sécurité en sont un sous-ensemble', async () => {
    const c = await connectAs('cp_app', db);
    const r = await c.query(`select unnest(enum_range(null::app.email_kind))::text as v`);
    await c.end();
    expect(r.rows.map((x) => x.v as string).sort()).toEqual([...EMAIL_KINDS].sort());
    for (const k of SECURITY_KINDS) expect(EMAIL_KINDS).toContain(k);
  });
});
