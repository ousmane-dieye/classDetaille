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

/**
 * `POST /api/me/step-up` (202) : le mot de passe prouve qui on est, le code part par email.
 * Étape « password » de la vérification supplémentaire (R13) — réservée aux actions sensibles.
 */
export function startStepUp(password: string): Promise<{ expiresInSeconds: number }> {
  return apiFetch<{ expiresInSeconds: number }>('/api/me/step-up', { method: 'POST', body: { password } });
}

/** `POST /api/me/step-up/verify` (204) : pose `step_up_at` sur la session courante. */
export function verifyStepUp(code: string): Promise<void> {
  return apiFetch<void>('/api/me/step-up/verify', { method: 'POST', body: { code } });
}

/** `POST /api/me/account` (204) : suppression du compte (R4). Les sessions partent avec la réponse. */
export function deleteAccount(password: string): Promise<void> {
  return apiFetch<void>('/api/me/account', { method: 'POST', body: { password } });
}
