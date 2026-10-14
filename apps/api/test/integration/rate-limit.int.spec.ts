import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/load-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { BUCKET_ROW_CAP, LoginRateLimiter } from '../../src/modules/auth/login-rate-limiter.js';
import { RateLimitRepository } from '../../src/modules/auth/rate-limit.repository.js';
import { connectAs, createTestDatabase, dbConfigFor } from '../support/pg.js';

let db: string;
let prisma: PrismaService;
let limiter: LoginRateLimiter;
const config = { security: { rateLimitHmacKey: 'k'.repeat(64) }, limits: { loginPerIp: 3 } } as AppConfig;

beforeAll(async () => {
  db = await createTestDatabase();
  prisma = new PrismaService(dbConfigFor('cp_app', db));
  limiter = new LoginRateLimiter(new RateLimitRepository(prisma), config);
});
afterAll(async () => { await prisma.onModuleDestroy(); });
beforeEach(async () => { await sql('delete from app.rate_limit_buckets'); });

async function sql(text: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return await c.query(text, params); } finally { await c.end(); }
}
/** Le temps : on vieillit le dernier échec au lieu d'avancer l'horloge (§ 5.3). */
const ageFailures = (key: string) => sql(`update app.rate_limit_buckets set last_failure_at = last_failure_at - interval '1 hour' where key = $1`, [key]);

describe('LoginRateLimiter (§ 3.2)', () => {
  it('clés : préfixe IP et HMAC de l’email, jamais l’email en clair', async () => {
    const k = limiter.keys('2001:db8:1:2:aa::1', 'awa@example.com');
    expect(k.ipKey).toBe('ip:2001:db8:1:2::');
    expect(k.accountKey).toMatch(/^ip\+acct:2001:db8:1:2:::[0-9a-f]{64}$/);
    expect(k.accountKey).not.toContain('awa');
  });
  it('par IP : la tentative au-delà de la limite est refusée jusqu’à la fin de la fenêtre', async () => {
    const k = limiter.keys('203.0.113.1', 'a@example.com');
    for (let i = 0; i < 3; i++) expect((await limiter.check(k, false)).kind).toBe('allowed');
    const g = await limiter.check(k, false);
    expect(g).toMatchObject({ kind: 'limited' });
    expect((g as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(800);
  });
  it('par IP + compte : délai croissant, Turnstile après 3 échecs, refus au 5ᵉ échec', async () => {
    const k = limiter.keys('203.0.113.2', 'b@example.com');
    const big = new LoginRateLimiter(new RateLimitRepository(prisma), { ...config, limits: { ...config.limits, loginPerIp: 100 } } as AppConfig);
    expect(await big.recordFailure(k, false)).toEqual({ turnstileRequired: false });
    expect(await big.check(k, false)).toEqual({ kind: 'limited', retryAfterSeconds: 1 });
    await ageFailures(k.accountKey);
    await big.recordFailure(k, false);
    await ageFailures(k.accountKey);
    expect(await big.recordFailure(k, false)).toEqual({ turnstileRequired: true });
    await ageFailures(k.accountKey);
    expect(await big.check(k, false)).toEqual({ kind: 'allowed', turnstileRequired: true });
    await big.recordFailure(k, false); await ageFailures(k.accountKey);
    await big.recordFailure(k, false); await ageFailures(k.accountKey);
    expect((await big.check(k, false)).kind).toBe('limited');
  });
  it('un compte n’est jamais bloqué depuis une autre IP', async () => {
    const big = new LoginRateLimiter(new RateLimitRepository(prisma), { ...config, limits: { ...config.limits, loginPerIp: 100 } } as AppConfig);
    const attacker = big.keys('198.51.100.66', 'victim@example.com');
    for (let i = 0; i < 5; i++) { await big.recordFailure(attacker, false); await ageFailures(attacker.accountKey); }
    expect((await big.check(attacker, false)).kind).toBe('limited');
    expect(await big.check(big.keys('203.0.113.77', 'victim@example.com'), false)).toEqual({ kind: 'allowed', turnstileRequired: false });
  });
  it('un succès efface le seau IP + compte', async () => {
    const big = new LoginRateLimiter(new RateLimitRepository(prisma), { ...config, limits: { ...config.limits, loginPerIp: 100 } } as AppConfig);
    const k = big.keys('203.0.113.3', 'c@example.com');
    await big.recordFailure(k, false);
    await big.recordSuccess(k);
    expect((await sql('select count(*)::int as n from app.rate_limit_buckets where key = $1', [k.accountKey])).rows[0].n).toBe(0);
  });
  it('mode dégradé : 5 par IP et 2 par couple, sans Turnstile', async () => {
    const big = new LoginRateLimiter(new RateLimitRepository(prisma), { ...config, limits: { ...config.limits, loginPerIp: 100 } } as AppConfig);
    const k = big.keys('203.0.113.4', 'd@example.com');
    await big.recordFailure(k, true); await ageFailures(k.accountKey);
    expect(await big.recordFailure(k, true)).toEqual({ turnstileRequired: false });
    await ageFailures(k.accountKey);
    expect((await big.check(k, true)).kind).toBe('limited');
    const ipOnly = big.keys('203.0.113.5', 'e@example.com');
    for (let i = 0; i < 5; i++) expect((await big.check(ipOnly, true)).kind).toBe('allowed');
    expect((await big.check(ipOnly, true)).kind).toBe('limited');
  });
  it('alerte au 51ᵉ échec d’une IP dans la fenêtre', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const k = limiter.keys('203.0.113.6', 'f@example.com');
    await limiter.check(k, false);
    await sql(`update app.rate_limit_buckets set failures = 50 where key = $1`, [k.ipKey]);
    await limiter.recordFailure(k, false);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/login failures above 50/);
    warn.mockRestore();
  });
  it('au-delà de 50 000 lignes, seule la limite par IP s’applique, avec alerte', async () => {
    await sql(`insert into app.rate_limit_buckets (key, window_start) select 'ip:10.' || (g / 65536) || '.' || ((g / 256) % 256) || '.' || (g % 256), clock_timestamp() from generate_series(1, $1::int) g`, [BUCKET_ROW_CAP + 1]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const k = limiter.keys('203.0.113.7', 'g@example.com');
    await limiter.check(k, false);
    await limiter.recordFailure(k, false);
    expect((await sql('select count(*)::int as n from app.rate_limit_buckets where key = $1', [k.accountKey])).rows[0].n).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/above 50000 rows/);
    warn.mockRestore();
  });
});
