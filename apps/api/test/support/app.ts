import 'reflect-metadata';
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
