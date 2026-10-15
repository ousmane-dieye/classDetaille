import { afterEach, describe, expect, it, vi } from 'vitest';
import { login } from './auth';

vi.mock('./client', () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe('api connexion', () => {
  it('ouvre une session étudiante quand le serveur répond 200', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({ id: 'u1', firstName: 'Awa' });
    const result = await login({ email: 'awa@example.com', password: 'une phrase de passe' });
    expect(result.kind).toBe('ok');
    expect(apiFetch).toHaveBeenCalledWith('/api/auth/login', { method: 'POST', body: { email: 'awa@example.com', password: 'une phrase de passe' } });
  });

  it('demande le code administrateur quand le serveur répond 202', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({ status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: 600, resendAfterSeconds: 60 });
    const result = await login({ email: 'admin@example.com', password: 'x' });
    expect(result).toEqual({ kind: 'second-factor', expiresInSeconds: 600, resendAfterSeconds: 60 });
  });

  it('n’envoie le jeton anti-robot que s’il existe (schéma strict côté serveur)', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({ id: 'u1' });
    await login({ email: 'a@example.com', password: 'x', turnstileToken: 'jeton' });
    expect(apiFetch).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      body: { email: 'a@example.com', password: 'x', turnstileToken: 'jeton' },
    });
  });

  it('laisse les erreurs du serveur telles quelles', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockRejectedValue({ code: 'INVALID_CREDENTIALS', status: 401, extra: { turnstileRequired: true } });
    await expect(login({ email: 'a@example.com', password: 'x' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});
