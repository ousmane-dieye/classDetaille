import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DbConfig } from '../../src/config/load-config.js';

export const API_DIR = resolve(import.meta.dirname, '../..');

const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');

export function envForDb(db: DbConfig): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cp-prisma-'));
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    // Windows : variables système nécessaires à Node et aux moteurs Prisma.
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP } : {}),
    NODE_ENV: 'test',
    HTTP_PORT: '3000',
    READY_PORT: '3001',
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_NAME: db.database,
    DB_USER: db.user,
    DB_AUTH_MODE: db.auth.mode,
  };
  if (db.auth.mode === 'password') {
    const pw = join(dir, 'pw');
    writeFileSync(pw, db.auth.password, { mode: 0o600 });
    return { env: { ...base, DB_PASSWORD_FILE: pw }, dir };
  }
  const env: NodeJS.ProcessEnv = { ...base, DB_SSL_CA_FILE: db.auth.caFile, DB_SSL_CERT_FILE: db.auth.certFile, DB_SSL_KEY_FILE: db.auth.keyFile };
  if (db.auth.p12File) env.DB_SSL_P12_FILE = db.auth.p12File;
  if (db.auth.p12Password !== undefined) {
    const p = join(dir, 'p12pw');
    writeFileSync(p, db.auth.p12Password, { mode: 0o600 });
    env.DB_SSL_P12_PASSWORD_FILE = p;
  }
  return { env, dir };
}

export function runPrisma(args: string[], db: DbConfig, opts: { configPath?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const full = opts.configPath ? [...args, '--config', opts.configPath] : args;
  const { env, dir } = envForDb(db);
  return new Promise((done) => {
    execFile(process.execPath, [PRISMA_CLI, ...full], { cwd: API_DIR, env, timeout: 120_000 }, (err, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
