import { apiFetch } from './client';
import type { Me, Session } from './types';

/** `PATCH /api/me/profile` (200 profil). */
export function updateProfile(body: { firstName: string; lastName: string }): Promise<Me> {
  return apiFetch<Me>('/api/me/profile', { method: 'PATCH', body });
}

/** `PATCH /api/me/email-preferences` (200 profil) : les deux préférences voyagent ensemble. */
export function updatePreferences(body: { emailReminders: boolean; emailAnnouncements: boolean }): Promise<Me> {
  return apiFetch<Me>('/api/me/email-preferences', { method: 'PATCH', body });
}

/** `POST /api/me/password` (204) : les anciennes sessions sont révoquées côté serveur. */
export function changePassword(body: { currentPassword: string; newPassword: string }): Promise<void> {
  return apiFetch<void>('/api/me/password', { method: 'POST', body });
}

/** `GET /api/me/sessions` : la session courante est marquée `current` par le serveur. */
export function listSessions(): Promise<Session[]> {
  return apiFetch<Session[]>('/api/me/sessions');
}

/** `POST /api/me/sessions/revoke-others` (200) : nombre d'appareils déconnectés. */
export function revokeOtherSessions(): Promise<{ revoked: number }> {
  return apiFetch<{ revoked: number }>('/api/me/sessions/revoke-others', { method: 'POST', body: {} });
}
