import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgotPassword, resetPassword } from './auth';

vi.mock('./client', () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe('api mot de passe oublié', () => {
  it('envoie toujours le jeton anti-robot (obligatoire côté serveur)', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({ status: 'RESET_REQUESTED' });
    const result = await forgotPassword({ email: 'awa@example.com', turnstileToken: 'jeton' });
    expect(result).toEqual({ status: 'RESET_REQUESTED' });
    expect(apiFetch).toHaveBeenCalledWith('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: 'awa@example.com', turnstileToken: 'jeton' },
    });
  });

  it('réinitialise avec le jeton du lien et le nouveau mot de passe', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    await resetPassword({ token: 'A'.repeat(43), newPassword: 'une phrase de passe neuve' });
    expect(apiFetch).toHaveBeenCalledWith('/api/auth/reset-password', {
      method: 'POST',
      body: { token: 'A'.repeat(43), newPassword: 'une phrase de passe neuve' },
    });
  });
});
