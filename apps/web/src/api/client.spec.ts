import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiProblem } from './client';

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

afterEach(() => {
  vi.unstubAllGlobals();
});

function fetchSpy(impl: (input: string, init: RequestInit) => Promise<Response>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('client HTTP', () => {
  it('envoie des requêtes sur la même origine, avec le cookie de session', async () => {
    const spy = fetchSpy(async () => jsonResponse(200, { ok: true }));
    await apiFetch('/api/me');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/me');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('pose Content-Type JSON et envoie le corps pour une requête qui modifie', async () => {
    const spy = fetchSpy(async () => jsonResponse(201, {}));
    await apiFetch('/api/auth/register', { method: 'POST', body: { email: 'awa@example.com' } });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"email":"awa@example.com"}');
  });

  it('envoie un objet JSON vide pour un corps vide (jamais sans corps)', async () => {
    const spy = fetchSpy(async () => jsonResponse(202, {}));
    await apiFetch('/api/auth/resend-code', { method: 'POST', body: {} });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('{}');
  });

  it('transforme une erreur de l’API en ApiProblem lisible', async () => {
    fetchSpy(async () => jsonResponse(400, { error: { code: 'CODE_INVALID', attemptsLeft: 4 }, requestId: 'req-7' }));
    const e = await apiFetch('/api/auth/verify-code', { method: 'POST', body: { code: '123456' } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiProblem);
    const p = e as ApiProblem;
    expect(p.status).toBe(400);
    expect(p.code).toBe('CODE_INVALID');
    expect(p.extra.attemptsLeft).toBe(4);
    expect(p.requestId).toBe('req-7');
    expect(p.retryAfterSeconds).toBeNull();
  });

  it('lit l’en-tête Retry-After pour un 429 ou un 503', async () => {
    fetchSpy(async () =>
      jsonResponse(429, { error: { code: 'TOO_MANY_ATTEMPTS' }, requestId: 'r' }, { 'retry-after': '45' }),
    );
    const e = (await apiFetch('/api/auth/login', { method: 'POST', body: {} }).catch((x: unknown) => x)) as ApiProblem;
    expect(e.code).toBe('TOO_MANY_ATTEMPTS');
    expect(e.retryAfterSeconds).toBe(45);
  });

  it('refuse une réponse illisible sans jamais afficher de détail interne', async () => {
    fetchSpy(async () => new Response('<html>panne</html>', { status: 500 }));
    const e = (await apiFetch('/api/me').catch((x: unknown) => x)) as ApiProblem;
    expect(e).toBeInstanceOf(ApiProblem);
    expect(e.status).toBe(500);
    expect(e.code).toBe('INTERNAL');
  });

  it('signale une requête qui n’arrive pas au serveur', async () => {
    fetchSpy(async () => Promise.reject(new TypeError('Failed to fetch')));
    const e = (await apiFetch('/api/me').catch((x: unknown) => x)) as ApiProblem;
    expect(e).toBeInstanceOf(ApiProblem);
    expect(e.status).toBe(0);
    expect(e.code).toBe('NETWORK');
  });
});
