import 'reflect-metadata';
import { Writable } from 'node:stream';
import { Body, Controller, Get, Injectable, Module, Post, Req } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/load-config.js';
import { ReadinessProbe } from '../health/readiness.service.js';
import { buildApiApp } from './app.js';
import { Public } from './public.decorator.js';
import { ThrottleGuardModule } from './throttle.js';
import { ZodPipe } from './zod.pipe.js';

@Injectable()
class OkProbe extends ReadinessProbe { async check() { return true; } }

const Echo = z.strictObject({ name: z.string().max(10) });
@Public()
@Controller('t')
class TestController {
  @Get('boom') boom(): never { throw new Error('password=hunter2'); }
  @Get('ip') ip(@Req() req: FastifyRequest) { return { ip: req.ip }; }
  @Post('echo') echo(@Body(new ZodPipe(Echo)) b: z.infer<typeof Echo>) { return b; }
}
@Module({ controllers: [TestController] })
class TestModule {}

const ORIGIN = 'https://app.test';
const config: AppConfig = {
  nodeEnv: 'test', httpPort: 0, readyPort: 0, readyHost: '127.0.0.1',
  db: { host: '127.0.0.1', port: 1, database: 'x', user: 'cp_app', auth: { mode: 'password', password: 'x' } },
  http: { origin: ORIGIN, trustProxy: 0, logLevel: 'silent' },
  security: { rateLimitHmacKey: 'k'.repeat(64) },
  turnstile: { secret: 's', verifyUrl: 'http://127.0.0.1:1/' },
  limits: { loginPerIp: 100, throttlePerIp: 5, throttlePerSession: 300 },
};

let app: NestFastifyApplication;
const logs: string[] = [];
beforeAll(async () => {
  const logStream = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
  ({ app } = await buildApiApp(config, { probe: OkProbe, logStream, features: () => [ThrottleGuardModule, TestModule] }));
});
afterAll(async () => { await app.close(); });

let ipCounter = 0;
const nextIp = () => `198.51.100.${++ipCounter}`;
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as string, remoteAddress: nextIp(), headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers } });

describe('socle HTTP', () => {
  it('chaque réponse porte x-request-id, repris dans le corps des erreurs ; aucune trace', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/t/boom', remoteAddress: nextIp() });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL' }, requestId: res.headers['x-request-id'] });
    expect(res.body).not.toContain('hunter2');
  });
  it('un x-request-id fourni par le client est ignoré', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: nextIp(), headers: { 'x-request-id': 'forged' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).not.toBe('forged');
  });
  it('404 au format commun, sans le chemin demandé', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope?token=abc', remoteAddress: nextIp() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND' }, requestId: res.headers['x-request-id'] });
  });
  it('requête valide acceptée', async () => {
    const res = await post('/api/t/echo', { name: 'ok' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: 'ok' });
  });
  it('validation : champ inconnu refusé, valeur jamais recopiée', async () => {
    const res = await post('/api/t/echo', { name: 'ok', role: 'ADMIN-SECRET' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'VALIDATION_FAILED', fields: ['(body)'] }, requestId: res.headers['x-request-id'] });
    expect(res.body).not.toContain('ADMIN-SECRET');
  });
  it('validation : valeur invalide → champ nommé, valeur jamais recopiée', async () => {
    const res = await post('/api/t/echo', { name: 'VALEUR-TROP-LONGUE' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: 'VALIDATION_FAILED', fields: ['name'] });
    expect(res.body).not.toContain('VALEUR-TROP-LONGUE');
  });
  it('JSON invalide → 400 INVALID_JSON sans écho', async () => {
    const res = await post('/api/t/echo', '{"name": secret-value');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'INVALID_JSON' }, requestId: res.headers['x-request-id'] });
    expect(res.body).not.toContain('secret-value');
  });
  it('corps JSON vide → 400 INVALID_JSON', async () => {
    const res = await post('/api/t/echo', '');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_JSON');
  });
  it('__proto__ dans le corps → 400 INVALID_JSON', async () => {
    const res = await post('/api/t/echo', '{"name":"a","__proto__":{"x":1}}');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_JSON');
  });
  it('corps de plus de 100 Ko → 413 au format commun', async () => {
    const res = await post('/api/t/echo', JSON.stringify({ name: 'x'.repeat(101 * 1024) }));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE' }, requestId: res.headers['x-request-id'] });
  });
  it('CSRF : Origin étranger → 403 ; sans Origin ni Sec-Fetch-Site → 403 ; same-origin → accepté', async () => {
    const evil = await post('/api/t/echo', { name: 'a' }, { origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(403);
    expect(evil.json()).toEqual({ error: { code: 'CSRF_REJECTED' }, requestId: evil.headers['x-request-id'] });
    const noOrigin = await app.inject({ method: 'POST', url: '/api/t/echo', payload: { name: 'a' }, remoteAddress: nextIp(), headers: { 'content-type': 'application/json' } });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json().error.code).toBe('CSRF_REJECTED');
    const sameOrigin = await app.inject({ method: 'POST', url: '/api/t/echo', payload: { name: 'a' }, remoteAddress: nextIp(), headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } });
    expect(sameOrigin.statusCode).toBe(201);
  });
  it('Content-Type autre que JSON → 415', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/t/echo', payload: 'name=a', remoteAddress: nextIp(), headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' }, requestId: res.headers['x-request-id'] });
  });
  it('aucun en-tête CORS n’est émis', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/api/t/echo', remoteAddress: nextIp(), headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('TRUST_PROXY=0 : X-Forwarded-For est ignoré', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/t/ip', remoteAddress: '198.51.100.99', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(res.json()).toEqual({ ip: '198.51.100.99' });
  });
  it('limitation générale par IP, commune à toutes les routes : 429 avec Retry-After', async () => {
    const ip = '203.0.113.250';
    for (let i = 0; i < 4; i++) expect((await app.inject({ method: 'GET', url: '/api/health', remoteAddress: ip })).statusCode).toBe(200);
    // 5ᵉ requête sur une autre route : même compteur.
    expect((await app.inject({ method: 'POST', url: '/api/t/echo', payload: { name: 'a' }, remoteAddress: ip, headers: { origin: ORIGIN, 'content-type': 'application/json' } })).statusCode).toBe(201);
    const last = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: ip });
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(last.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(last.json()).toEqual({ error: { code: 'TOO_MANY_REQUESTS', retryAfter: Number(last.headers['retry-after']) }, requestId: last.headers['x-request-id'] });
  });
  it('les journaux ne contiennent ni cookie ni chaîne de requête', async () => {
    await app.inject({ method: 'GET', url: '/api/health?token=tok-123', remoteAddress: nextIp(), headers: { cookie: '__Host-cp_session=COOKIE-VALUE' } });
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain('COOKIE-VALUE');
    expect(all).not.toContain('tok-123');
  });
});

describe('limitation générale par session ; mandataire de confiance', () => {
  let sessionApp: NestFastifyApplication;
  beforeAll(async () => {
    const cfg: AppConfig = { ...config, http: { ...config.http, trustProxy: 1 }, limits: { ...config.limits, throttlePerIp: 100, throttlePerSession: 2 } };
    ({ app: sessionApp } = await buildApiApp(cfg, { probe: OkProbe, features: () => [ThrottleGuardModule, TestModule] }));
  });
  afterAll(async () => { await sessionApp.close(); });

  it('le même cookie de session est limité quelle que soit l’IP ; un autre cookie ne l’est pas', async () => {
    const get = (ip: string, token: string) =>
      sessionApp.inject({ method: 'GET', url: '/api/health', remoteAddress: ip, headers: { cookie: `__Host-cp_session=${token}` } });
    expect((await get('198.51.100.201', 'tok-A')).statusCode).toBe(200);
    expect((await get('198.51.100.202', 'tok-A')).statusCode).toBe(200);
    const third = await get('198.51.100.203', 'tok-A');
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
    expect((await get('198.51.100.204', 'tok-B')).statusCode).toBe(200);
  });
  it('TRUST_PROXY=1 : seule la dernière entrée de X-Forwarded-For est crue', async () => {
    const res = await sessionApp.inject({ method: 'GET', url: '/api/t/ip', remoteAddress: '10.0.0.2', headers: { 'x-forwarded-for': '192.0.2.66, 203.0.113.9' } });
    expect(res.json()).toEqual({ ip: '203.0.113.9' });
  });
});
