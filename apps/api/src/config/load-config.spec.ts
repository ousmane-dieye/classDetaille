import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './load-config.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-cfg-'));
const pw = join(dir, 'pw');
writeFileSync(pw, 'dev-password\n');

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
};

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
    const secretFile = join(dir, 'secret');
    writeFileSync(secretFile, `${value}\n`);
    const cases: Record<string, string | undefined>[] = [
      // Fichier de secret configuré, mode mot de passe refusé en production.
      { ...base, DB_PASSWORD_FILE: secretFile, NODE_ENV: 'production' },
      // Erreur de validation d'un autre champ, secret configuré.
      { ...base, DB_PASSWORD_FILE: secretFile, DB_PORT: 'abc' },
      // Mode cert : fichier de mot de passe PKCS#12 configuré, clé privée manquante.
      { ...base, DB_AUTH_MODE: 'cert', DB_PASSWORD_FILE: undefined, DB_SSL_CA_FILE: '/x/ca', DB_SSL_CERT_FILE: '/x/c', DB_SSL_P12_PASSWORD_FILE: secretFile },
      // Secret passé aussi directement : refusé sans recopier la valeur.
      { ...base, DB_PASSWORD_FILE: secretFile, PGPASSWORD: value },
    ];
    for (const env of cases) {
      let message = '';
      try { loadConfig(env); } catch (e) { message = String((e as Error).message); }
      expect(message, 'une erreur est attendue').not.toBe('');
      expect(message).not.toContain(value);
    }
    // Contre-épreuve : la lecture fonctionne bien quand la configuration est valide.
    expect(loadConfig({ ...base, DB_PASSWORD_FILE: secretFile }).db.auth).toEqual({ mode: 'password', password: value });
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
