import { afterEach, describe, expect, it, vi } from 'vitest';
import { resendCode, verifyCode } from './auth';

vi.mock('./client', () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe('api code à 6 chiffres', () => {
  it('valide le code et renvoie le profil', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({ id: 'u1' });
    const me = await verifyCode({ code: '482190' });
    expect(me).toEqual({ id: 'u1' });
    expect(apiFetch).toHaveBeenCalledWith('/api/auth/verify-code', { method: 'POST', body: { code: '482190' } });
  });

  it('relance l’envoi et renvoie les nouveaux délais', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({ status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: 600, resendAfterSeconds: 60 });
    await expect(resendCode()).resolves.toEqual({ expiresInSeconds: 600, resendAfterSeconds: 60 });
    expect(apiFetch).toHaveBeenCalledWith('/api/auth/resend-code', { method: 'POST' });
  });
});
