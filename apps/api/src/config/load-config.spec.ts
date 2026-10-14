import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadDbConfig, loadOpsConfig, loadWorkerConfig } from './load-config.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-cfg-'));
const pw = join(dir, 'pw');
writeFileSync(pw, 'dev-password\n');
const hmac = join(dir, 'hmac');
writeFileSync(hmac, `${'a1'.repeat(32)}\n`);
const turnstile = join(dir, 'turnstile');
writeFileSync(turnstile, '1x0000000000000000000000000000000AA\n');

const hex = 'a'.repeat(64);
/** Écrit un fichier de secret temporaire et renvoie son chemin. */
let secretSeq = 0;
function secretFile(value: string): string {
  const p = join(dir, `secret-${secretSeq++}`);
  writeFileSync(p, `${value}\n`);
  return p;
}
const otpPepper = secretFile('p'.repeat(40));
const outboxKey = secretFile(hex);

const base = {
  NODE_ENV: 'development',
  HTTP_PORT: '3000',
  READY_PORT: '3001',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'classepulse',
  DB_USER: 'cp_app',
  DB_AUTH_MODE: 'password',
  DB_PASSWORD_FILE: pw,
  APP_ORIGIN: 'http://localhost:5173',
  RATE_LIMIT_HMAC_KEY_FILE: hmac,
  TURNSTILE_SECRET_FILE: turnstile,
  OTP_PEPPER_FILE: otpPepper,
  OUTBOX_PAYLOAD_KEY_FILE: outboxKey,
};

/** Variables de la base seules (NODE_ENV et DB_*), pour le worker et ops. */
const dbOnlyEnv = () => Object.fromEntries(Object.entries(base).filter(([k]) => k === 'NODE_ENV' || k.startsWith('DB_')));

describe('loadConfig', () => {
  it('construit une configuration typée en mode mot de passe (développement)', () => {
    const cfg = loadConfig(base);
    expect(cfg.httpPort).toBe(3000);
    expect(cfg.readyPort).toBe(3001);
    expect(cfg.readyHost).toBe('127.0.0.1');
    expect(cfg.db.auth).toEqual({ mode: 'password', password: 'dev-password' });
  });
  it('refuse une variable manquante', () => {
    const env: Partial<typeof base> = { ...base };
    delete env.DB_HOST;
    expect(() => loadConfig(env)).toThrow(/DB_HOST/);
  });
  it('refuse le mode mot de passe en production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/password mode is not allowed in production/);
  });
  it('refuse un secret passé directement dans une variable', () => {
    expect(() => loadConfig({ ...base, DB_PASSWORD: 'x' })).toThrow(/DB_PASSWORD must not be set/);
  });
  it.each(['DATABASE_URL', 'PGPASSWORD', 'PGPASSFILE'])('refuse %s (secret ou fichier de secrets lu hors *_FILE)', (key) => {
    expect(() => loadConfig({ ...base, [key]: 'x' })).toThrow(new RegExp(`${key} must not be set`));
  });
  it('READY_HOST est configurable (127.0.0.1 par défaut)', () => {
    expect(loadConfig({ ...base, READY_HOST: '0.0.0.0' }).readyHost).toBe('0.0.0.0');
    expect(() => loadConfig({ ...base, READY_HOST: '' })).toThrow(/READY_HOST/);
  });
  it('un message d’erreur ne contient jamais le contenu d’un fichier de secret', () => {
    const value = `S3CRET_${Math.random().toString(36).slice(2)}`;
    const leaked = join(dir, 'secret');
    writeFileSync(leaked, `${value}\n`);
    const cases: Record<string, string | undefined>[] = [
      // Fichier de secret configuré, mode mot de passe refusé en production.
      { ...base, DB_PASSWORD_FILE: leaked, NODE_ENV: 'production' },
      // Erreur de validation d'un autre champ, secret configuré.
      { ...base, DB_PASSWORD_FILE: leaked, DB_PORT: 'abc' },
      // Mode cert : fichier de mot de passe PKCS#12 configuré, clé privée manquante.
      { ...base, DB_AUTH_MODE: 'cert', DB_PASSWORD_FILE: undefined, DB_SSL_CA_FILE: '/x/ca', DB_SSL_CERT_FILE: '/x/c', DB_SSL_P12_PASSWORD_FILE: leaked },
      // Secret passé aussi directement : refusé sans recopier la valeur.
      { ...base, DB_PASSWORD_FILE: leaked, PGPASSWORD: value },
      // Clé HMAC lue depuis le fichier de secret, autre variable invalide.
      { ...base, RATE_LIMIT_HMAC_KEY_FILE: leaked, APP_ORIGIN: 'pas une url' },
      // Clé HMAC trop courte : refusée sans recopier sa valeur.
      { ...base, RATE_LIMIT_HMAC_KEY_FILE: leaked },
    ];
    for (const env of cases) {
      let message = '';
      try { loadConfig(env); } catch (e) { message = String((e as Error).message); }
      expect(message, 'une erreur est attendue').not.toBe('');
      expect(message).not.toContain(value);
    }
    // Contre-épreuve : la lecture fonctionne bien quand la configuration est valide.
    expect(loadConfig({ ...base, DB_PASSWORD_FILE: leaked }).db.auth).toEqual({ mode: 'password', password: value });
  });
  it('lit l’origine, les secrets de sécurité et les seuils par défaut', () => {
    const cfg = loadConfig(base);
    expect(cfg.http).toEqual({ origin: 'http://localhost:5173', trustProxy: 0, logLevel: 'info' });
    expect(cfg.security.rateLimitHmacKey).toBe('a1'.repeat(32));
    expect(cfg.turnstile).toEqual({ secret: '1x0000000000000000000000000000000AA', verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify' });
    expect(cfg.limits).toEqual({ loginPerIp: 100, throttlePerIp: 600, throttlePerSession: 300 });
  });
  it('normalise APP_ORIGIN et refuse un chemin', () => {
    expect(loadConfig({ ...base, APP_ORIGIN: 'https://classepulse.example/' }).http.origin).toBe('https://classepulse.example');
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'https://classepulse.example/app' })).toThrow(/APP_ORIGIN/);
  });
  it('refuse une clé HMAC de moins de 32 caractères', () => {
    writeFileSync(join(dir, 'short'), 'abc\n');
    expect(() => loadConfig({ ...base, RATE_LIMIT_HMAC_KEY_FILE: join(dir, 'short') })).toThrow(/RATE_LIMIT_HMAC_KEY/);
  });
  it('loadDbConfig ne demande que les variables de la base', () => {
    expect(loadDbConfig(dbOnlyEnv()).user).toBe('cp_app');
  });
  it('lit les chemins des certificats en mode cert', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'production',
      DB_AUTH_MODE: 'cert',
      DB_PASSWORD_FILE: undefined,
      DB_SSL_CA_FILE: '/run/secrets/ca.crt',
      DB_SSL_CERT_FILE: '/run/secrets/client.crt',
      DB_SSL_KEY_FILE: '/run/secrets/client.key',
    });
    expect(cfg.db.auth).toEqual({ mode: 'cert', caFile: '/run/secrets/ca.crt', certFile: '/run/secrets/client.crt', keyFile: '/run/secrets/client.key' });
  });
});

describe('lot 1b : secrets et worker', () => {
  it('loadConfig lit OTP_PEPPER_FILE et OUTBOX_PAYLOAD_KEY_FILE', () => {
    const c = loadConfig({ ...base, OTP_PEPPER_FILE: secretFile('p'.repeat(40)), OUTBOX_PAYLOAD_KEY_FILE: secretFile(hex) });
    expect(c.security.otpPepper).toBe('p'.repeat(40));
    expect(c.security.outboxPayloadKey).toEqual(Buffer.from(hex, 'hex'));
  });
  it.each([['court', hex], ['p'.repeat(40), 'zz'.repeat(32)], ['p'.repeat(40), 'a'.repeat(62)]])('refuse pepper %j / clé %j', (pepper, key) => {
    expect(() => loadConfig({ ...base, OTP_PEPPER_FILE: secretFile(pepper), OUTBOX_PAYLOAD_KEY_FILE: secretFile(key) })).toThrow(/OTP_PEPPER|OUTBOX_PAYLOAD_KEY/);
  });
  it('loadWorkerConfig : Mailpit en développement, sans identifiants', () => {
    const w = loadWorkerConfig({ ...dbOnlyEnv(), APP_ORIGIN: 'https://app.test', OUTBOX_PAYLOAD_KEY_FILE: secretFile(hex), MAIL_FROM: 'no-reply@app.test', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', SMTP_SECURITY: 'none' });
    expect(w.mail.smtp).toMatchObject({ host: '127.0.0.1', port: 1025, security: 'none', auth: null, timeoutMs: 30_000 });
  });
  it('loadWorkerConfig : SMTP_SECURITY=none refusé en production, identifiants incomplets refusés', () => {
    const env = { ...dbOnlyEnv(), APP_ORIGIN: 'https://app.test', OUTBOX_PAYLOAD_KEY_FILE: secretFile(hex), MAIL_FROM: 'no-reply@app.test', SMTP_HOST: 'smtp.example', SMTP_PORT: '587' };
    expect(() => loadWorkerConfig({ ...env, NODE_ENV: 'production', SMTP_SECURITY: 'none' })).toThrow(/SMTP_SECURITY/);
    expect(() => loadWorkerConfig({ ...env, SMTP_SECURITY: 'starttls', SMTP_USER: 'u' })).toThrow(/SMTP_PASSWORD_FILE/);
  });
  it('loadOpsConfig lit OTP_PEPPER_FILE et la base, rien d’autre', () => {
    const o = loadOpsConfig({ ...dbOnlyEnv(), OTP_PEPPER_FILE: secretFile('p'.repeat(40)) });
    expect(o.otpPepper).toBe('p'.repeat(40));
  });
});
