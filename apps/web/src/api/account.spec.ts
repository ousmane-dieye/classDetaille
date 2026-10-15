import { afterEach, describe, expect, it, vi } from 'vitest';
import { changePassword, listSessions, revokeOtherSessions, updatePreferences, updateProfile } from './account';

vi.mock('./client', () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe('api compte', () => {
  it('PATCH /api/me/profile renvoie le profil mis à jour', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({ id: 'u1', firstName: 'Awaïcha' });
    const me = await updateProfile({ firstName: 'Awaïcha', lastName: 'Diop' });
    expect(me).toEqual({ id: 'u1', firstName: 'Awaïcha' });
    expect(apiFetch).toHaveBeenCalledWith('/api/me/profile', {
      method: 'PATCH',
      body: { firstName: 'Awaïcha', lastName: 'Diop' },
    });
  });

  it('PATCH /api/me/email-preferences envoie les deux préférences', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({ id: 'u1' });
    await updatePreferences({ emailReminders: false, emailAnnouncements: true });
    expect(apiFetch).toHaveBeenCalledWith('/api/me/email-preferences', {
      method: 'PATCH',
      body: { emailReminders: false, emailAnnouncements: true },
    });
  });

  it('POST /api/me/password envoie le mot de passe actuel et le nouveau', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    await changePassword({ currentPassword: 'ancien mot de passe', newPassword: 'un nouveau mot de passe 2026' });
    expect(apiFetch).toHaveBeenCalledWith('/api/me/password', {
      method: 'POST',
      body: { currentPassword: 'ancien mot de passe', newPassword: 'un nouveau mot de passe 2026' },
    });
  });

  it('liste les sessions et révoque les autres appareils', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch)
      .mockResolvedValueOnce([{ id: 's1', current: true }])
      .mockResolvedValueOnce({ revoked: 2 });
    await expect(listSessions()).resolves.toEqual([{ id: 's1', current: true }]);
    await expect(revokeOtherSessions()).resolves.toEqual({ revoked: 2 });
    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/me/sessions');
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/me/sessions/revoke-others', { method: 'POST', body: {} });
  });
});
