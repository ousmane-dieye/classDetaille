import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../../http/clock.js';
import { HttpTurnstileVerifier, TurnstileGate, TurnstileVerifier, type VerifierResult } from './turnstile.js';

class FakeVerifier extends TurnstileVerifier {
  next: VerifierResult = 'valid';
  calls = 0;
  async verify() { this.calls++; return this.next; }
}
class FakeClock extends Clock { t = 1_000_000; now() { return new Date(this.t); } }

describe('TurnstileGate (§ 3.2, arbitrage M, R7)', () => {
  it('jeton absent → invalid, sans appel', async () => {
    const v = new FakeVerifier();
    expect(await new TurnstileGate(v, new FakeClock()).check(undefined, '1.2.3.4')).toBe('invalid');
    expect(v.calls).toBe(0);
  });
  it('3 erreurs consécutives → mode dégradé, plus d’appel pendant 60 s, nouvel essai ensuite', async () => {
    const v = new FakeVerifier();
    const clock = new FakeClock();
    const g = new TurnstileGate(v, clock);
    v.next = 'error';
    for (let i = 0; i < 3; i++) expect(await g.check('t', 'ip')).toBe('unavailable');
    expect(g.isDegraded()).toBe(true);
    expect(await g.check('t', 'ip')).toBe('unavailable');
    expect(v.calls).toBe(3);
    clock.t += 60_000;
    expect(g.isDegraded()).toBe(false);
    v.next = 'valid';
    expect(await g.check('t', 'ip')).toBe('valid');
    expect(v.calls).toBe(4);
  });
  it('un délai dépassé met en mode dégradé immédiatement', async () => {
    const v = new FakeVerifier();
    const g = new TurnstileGate(v, new FakeClock());
    v.next = 'timeout';
    expect(await g.check('t', 'ip')).toBe('unavailable');
    expect(g.isDegraded()).toBe(true);
  });
  it('un jeton refusé n’est pas une panne et remet le compteur d’erreurs à zéro', async () => {
    const v = new FakeVerifier();
    const g = new TurnstileGate(v, new FakeClock());
    v.next = 'error'; await g.check('t', 'ip'); await g.check('t', 'ip');
    v.next = 'invalid'; expect(await g.check('t', 'ip')).toBe('invalid');
    v.next = 'error'; await g.check('t', 'ip');
    expect(g.isDegraded()).toBe(false);
  });
});

describe('HttpTurnstileVerifier', () => {
  const server = Fastify();
  let behaviour: 'ok' | 'ko' | '500' | 'slow' = 'ok';
  let lastBody = '';
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  server.post('/verify', async (req, reply) => {
    lastBody = String(req.body);
    if (behaviour === '500') return reply.code(500).send({});
    if (behaviour === 'slow') await new Promise((r) => setTimeout(r, 300));
    return { success: behaviour === 'ok' };
  });
  let url = '';
  beforeAll(async () => { url = `${await server.listen({ port: 0, host: '127.0.0.1' })}/verify`; });
  afterAll(async () => { await server.close(); });

  it.each([['ok', 'valid'], ['ko', 'invalid'], ['500', 'error']] as const)('%s → %s', async (b, expected) => {
    behaviour = b;
    expect(await new HttpTurnstileVerifier('SECRET', url).verify('tok', '203.0.113.9')).toBe(expected);
  });
  it('envoie le secret, le jeton et l’IP en formulaire', async () => {
    behaviour = 'ok';
    await new HttpTurnstileVerifier('SECRET', url).verify('tok', '203.0.113.9');
    expect(new URLSearchParams(lastBody).get('secret')).toBe('SECRET');
    expect(new URLSearchParams(lastBody).get('response')).toBe('tok');
    expect(new URLSearchParams(lastBody).get('remoteip')).toBe('203.0.113.9');
  });
  it('délai dépassé → timeout', async () => {
    behaviour = 'slow';
    expect(await new HttpTurnstileVerifier('SECRET', url, 50).verify('tok', 'ip')).toBe('timeout');
  });
  it('service injoignable → error', async () => {
    expect(await new HttpTurnstileVerifier('SECRET', 'http://127.0.0.1:1/verify').verify('tok', 'ip')).toBe('error');
  });
});
