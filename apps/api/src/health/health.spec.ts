import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthModule } from './health.module.js';
import { ReadinessProbe } from './readiness.service.js';
import { ReadinessService } from './readiness.service.js';
import { buildReadyServer } from './ready-server.js';

class FakeProbe extends ReadinessProbe {
  ok = true;
  calls = 0;
  async check() { this.calls++; return this.ok; }
}

describe('santé', () => {
  let app: NestFastifyApplication;
  let probe: FakeProbe;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    probe = new FakeProbe();
    const mod = await Test.createTestingModule({ imports: [HealthModule.register(FakeProbe)] })
      .overrideProvider(ReadinessProbe).useValue(probe)
      .compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => { vi.useRealTimers(); await app.close(); });

  it('/api/health renvoie seulement le statut', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/api/health met la vérification en cache 10 s', async () => {
    await app.inject({ method: 'GET', url: '/api/health' });
    await app.inject({ method: 'GET', url: '/api/health' });
    expect(probe.calls).toBe(1);
    vi.setSystemTime(Date.now() + 10_001);
    probe.ok = false;
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ status: 'degraded' });
    expect(probe.calls).toBe(2);
  });

  it("/api/health/ready n'existe pas sur le port public", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(404);
  });

  it('le serveur interne répond 200 puis 503, sans cache', async () => {
    const ready = buildReadyServer(app.get(ReadinessService));
    expect((await ready.inject({ method: 'GET', url: '/api/health/ready' })).statusCode).toBe(200);
    probe.ok = false;
    expect((await ready.inject({ method: 'GET', url: '/api/health/ready' })).statusCode).toBe(503);
    await ready.close();
  });
});

describe('ReadinessService sans ruée', () => {
  it('5 appels concurrents sur cache froid déclenchent une seule sonde', async () => {
    let calls = 0;
    class SlowProbe extends ReadinessProbe {
      async check() { calls++; await new Promise((r) => setTimeout(r, 50)); return true; }
    }
    const svc = new ReadinessService(new SlowProbe());
    const res = await Promise.all(Array.from({ length: 5 }, () => svc.publicStatus()));
    expect(res).toEqual(Array(5).fill('ok'));
    expect(calls).toBe(1);
  });
});

describe('ReadinessService : délai de la sonde', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('une sonde qui ne répond jamais donne « non prête » après 2 s', async () => {
    vi.useFakeTimers();
    class HangingProbe extends ReadinessProbe {
      check() { return new Promise<boolean>(() => undefined); }
    }
    const svc = new ReadinessService(new HangingProbe());
    let result: boolean | undefined;
    const pending = svc.isReady().then((ok) => { result = ok; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('le minuteur est annulé quand la sonde répond à temps', async () => {
    vi.useFakeTimers();
    class FastProbe extends ReadinessProbe {
      async check() { return true; }
    }
    const svc = new ReadinessService(new FastProbe());
    await expect(svc.isReady()).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
