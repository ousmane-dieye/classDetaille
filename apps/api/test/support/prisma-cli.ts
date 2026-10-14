import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DbConfig } from '../../src/config/load-config.js';

export const API_DIR = resolve(import.meta.dirname, '../..');

const requireFromHere = createRequire(import.meta.url);
const PRISMA_CLI = requireFromHere.resolve('prisma/build/index.js');
// Le projet temporaire est hors de node_modules : `prisma/config` doit y être importé par chemin absolu.
const PRISMA_CONFIG_MODULE = requireFromHere.resolve('prisma/config').replaceAll('\\', '/');

export function envForDb(db: DbConfig): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cp-prisma-'));
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    // Windows : variables système nécessaires à Node et aux moteurs Prisma.
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP } : {}),
    NODE_ENV: 'test',
    // Pas de télémétrie Prisma (Checkpoint) depuis les tests et la CI.
    CHECKPOINT_DISABLE: '1',
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
  return new Promise((done) => {
    let prepared: { env: NodeJS.ProcessEnv; dir: string };
    try {
      prepared = envForDb(db);
    } catch (e) {
      done({ code: 1, stdout: '', stderr: String(e) });
      return;
    }
    const { env, dir } = prepared;
    execFile(process.execPath, [PRISMA_CLI, ...full], { cwd: API_DIR, env, timeout: 120_000 }, (err, stdout, stderr) => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } finally {
        done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
      }
    });
  });
}

/** Projet Prisma temporaire. Son `prisma.config.ts` définit toujours le datasource (l'environnement DB_* est toujours fourni par `runPrisma`). */
export function makeScratchPrismaProject(migrations: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-scratch-'));
  mkdirSync(join(dir, 'migrations'));
  writeFileSync(join(dir, 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
  for (const [name, sql] of Object.entries(migrations)) {
    mkdirSync(join(dir, 'migrations', name));
    writeFileSync(join(dir, 'migrations', name, 'migration.sql'), sql);
  }
  writeFileSync(join(dir, 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  schemas = ["app"]\n}\n');
  const cfg = join(dir, 'prisma.config.ts');
  const api = API_DIR.replaceAll('\\', '/');
  const scratch = dir.replaceAll('\\', '/');
  writeFileSync(
    cfg,
    `import { defineConfig } from '${PRISMA_CONFIG_MODULE}';
import { loadDbConfig } from '${api}/src/config/load-config.ts';
import { toPrismaCliUrl } from '${api}/src/config/database-connection.ts';
export default defineConfig({
  schema: '${scratch}/schema.prisma',
  migrations: { path: '${scratch}/migrations' },
  datasource: { url: toPrismaCliUrl(loadDbConfig(process.env)) },
});
`,
  );
  return cfg;
}

export function writeMigration(cfgPath: string, name: string, sql: string): void {
  const dir = join(cfgPath, '..', 'migrations', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'migration.sql'), sql);
}
