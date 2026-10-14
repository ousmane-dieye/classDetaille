import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { v7 as uuidv7 } from 'uuid';
import type { AppConfig } from '../../src/config/load-config.js';
import { buildApiApp } from '../../src/http/app.js';
import type { RouteInfo } from '../../src/http/routes.js';
import { TurnstileVerifier, type VerifierResult } from '../../src/modules/auth/turnstile.js';
import { connectAs, dbConfigFor } from './pg.js';

type LightMyRequestResponse = Awaited<ReturnType<NestFastifyApplication['inject']>>;

export const ORIGIN = 'https://app.test';

export function testConfig(db: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test', httpPort: 0, readyPort: 0, readyHost: '127.0.0.1',
    db: dbConfigFor('cp_app', db),
    http: { origin: ORIGIN, trustProxy: 0, logLevel: 'silent' },
    security: { rateLimitHmacKey: 'test-hmac-key-'.padEnd(64, 'x') },
    turnstile: { secret: 'unused', verifyUrl: 'http://127.0.0.1:1/' },
    limits: { loginPerIp: 100, throttlePerIp: 10_000, throttlePerSession: 10_000 },
    ...over,
  };
}

export class FakeTurnstile extends TurnstileVerifier {
  next: VerifierResult = 'valid';
  calls = 0;
  async verify(): Promise<VerifierResult> { this.calls++; return this.next; }
}

export type TestApp = { app: NestFastifyApplication; routes: RouteInfo[]; turnstile: FakeTurnstile; close: () => Promise<void> };

export async function buildTestApp(db: string, opts: { config?: Partial<AppConfig>; turnstile?: FakeTurnstile } = {}): Promise<TestApp> {
  const turnstile = opts.turnstile ?? new FakeTurnstile();
  const { app, routes } = await buildApiApp(testConfig(db, opts.config), { turnstile });
  return { app, routes, turnstile, close: () => app.close() };
}

let ipSeq = 0;
/** Une IP différente par appel, sauf si le test en impose une (les limitations sont par IP). */
export function freshIp(): string { ipSeq++; return `198.18.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`; }

export function send(app: NestFastifyApplication, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown,
  headers: Record<string, string> = {}, remoteAddress = freshIp()): Promise<LightMyRequestResponse> {
  const mutating = method !== 'GET';
  return app.inject({
    method, url, remoteAddress,
    ...(mutating ? { payload: (body ?? {}) as object } : {}),
    headers: { ...(mutating ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...headers },
  });
}

export function sessionCookieOf(res: LightMyRequestResponse): string | undefined {
  const raw = [res.headers['set-cookie']].flat().filter((v): v is string => typeof v === 'string');
  const c = raw.find((v) => v.startsWith('__Host-cp_session='));
  const value = c?.split(';')[0]?.slice('__Host-cp_session='.length);
  return value ? value : undefined;
}

export const cookieHeader = (token: string) => ({ cookie: `__Host-cp_session=${token}` });

export async function insertClass(db: string, name: string, opts: { year?: string; archived?: boolean } = {}): Promise<string> {
  const id = uuidv7();
  const c = await connectAs('cp_app', db);
  await c.query(`insert into app.classes (id, name, level, academic_year) values ($1, $2, 'L3', $3)`, [id, name, opts.year ?? '2026-2027']);
  await c.end();
  if (opts.archived) {
    // Préparation de donnée : cp_app ne peut pas archiver au lot 1.
    const o = await connectAs('cp_owner', db);
    await o.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [id]);
    await o.end();
  }
  return id;
}

export const PASSWORD = 'une phrase de passe assez longue';

export function registration(classId: string, over: Record<string, unknown> = {}) {
  const n = Math.random().toString(36).slice(2, 10);
  return { firstName: 'Awa', lastName: 'Diop', email: `awa.${n}@example.com`, password: PASSWORD, classId, turnstileToken: 'tok', ...over };
}

export async function registerStudent(app: NestFastifyApplication, classId: string, over: Record<string, unknown> = {}) {
  const body = registration(classId, over);
  const res = await send(app, 'POST', '/api/auth/register', body);
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  return { token: sessionCookieOf(res)!, email: String(body.email), password: String(body.password), userId: (res.json() as { id: string }).id };
}

export async function query(db: string, sql: string, params: unknown[] = [], role: 'cp_app' | 'cp_owner' = 'cp_app') {
  const c = await connectAs(role, db);
  try { return await c.query(sql, params); } finally { await c.end(); }
}

/** Lance la CLI avec une configuration lue depuis des fichiers secrets temporaires (jamais en variables). */
export async function runCli(db: string, args: string[], stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  const cfg = testConfig(db);
  const dir = mkdtempSync(join(tmpdir(), 'cp-cli-'));
  const file = (name: string, value: string) => { const p = join(dir, name); writeFileSync(p, `${value}\n`); return p; };
  const auth = cfg.db.auth as { password: string };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE,
    NODE_ENV: 'test', HTTP_PORT: '3000', READY_PORT: '3001', APP_ORIGIN: cfg.http.origin, LOG_LEVEL: 'silent',
    DB_HOST: cfg.db.host, DB_PORT: String(cfg.db.port), DB_NAME: cfg.db.database, DB_USER: 'cp_app', DB_AUTH_MODE: 'password',
    DB_PASSWORD_FILE: file('db', auth.password),
    RATE_LIMIT_HMAC_KEY_FILE: file('hmac', cfg.security.rateLimitHmacKey),
    TURNSTILE_SECRET_FILE: file('turnstile', cfg.turnstile.secret),
  };
  try {
    return await new Promise((done, fail) => {
      const p = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'src/cli.ts', ...args], { cwd: resolve(import.meta.dirname, '../..'), env });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', (d) => { stdout += String(d); });
      p.stderr.on('data', (d) => { stderr += String(d); });
      p.on('error', fail);
      p.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
      p.stdin.end(stdin);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
