import { apiFetch } from './client';
import type { AdminCodeRequired, ClassSummary, Me } from './types';

export type RegisterBody = {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  classId: string;
  turnstileToken: string;
};

/** `POST /api/auth/register` : la demande d'adhésion est créée dans la même transaction (lot 1a). */
export function register(body: RegisterBody): Promise<Me> {
  return apiFetch<Me>('/api/auth/register', { method: 'POST', body });
}

/** `POST /api/auth/login` : 200 avec le profil, ou 202 avec le compte à rebours du code (§ 3.3). */
export type LoginInput = { email: string; password: string; turnstileToken?: string };

export type LoginResult = { kind: 'ok'; me: Me } | { kind: 'second-factor'; expiresInSeconds: number; resendAfterSeconds: number };

export async function login(body: LoginInput): Promise<LoginResult> {
  // Le schéma du serveur est strict : le jeton n'est envoyé que s'il existe.
  const payload = body.turnstileToken === undefined ? { email: body.email, password: body.password } : body;
  const data = await apiFetch<Me | AdminCodeRequired>('/api/auth/login', { method: 'POST', body: payload });
  if (data && typeof data === 'object' && 'status' in data && data.status === 'ADMIN_CODE_REQUIRED') {
    return { kind: 'second-factor', expiresInSeconds: data.expiresInSeconds, resendAfterSeconds: data.resendAfterSeconds };
  }
  return { kind: 'ok', me: data as Me };
}

/** `GET /api/classes/active` : classes à choisir à l'inscription (publique). */
export function listActiveClasses(): Promise<ClassSummary[]> {
  return apiFetch<ClassSummary[]>('/api/classes/active');
}

/** `POST /api/auth/verify-code` : le code valide ouvre la session et renvoie le profil (§ 3.3). */
export function verifyCode(body: { code: string }): Promise<Me> {
  return apiFetch<Me>('/api/auth/verify-code', { method: 'POST', body });
}

/** `POST /api/auth/resend-code` : 202 avec les nouveaux délais (600 s / 60 s). */
export async function resendCode(): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> {
  const data = await apiFetch<AdminCodeRequired>('/api/auth/resend-code', { method: 'POST' });
  return { expiresInSeconds: data.expiresInSeconds, resendAfterSeconds: data.resendAfterSeconds };
}

/** `POST /api/auth/forgot-password` : réponse identique dans tous les cas (R9), jeton obligatoire. */
export function forgotPassword(body: { email: string; turnstileToken: string }): Promise<{ status: 'RESET_REQUESTED' }> {
  return apiFetch<{ status: 'RESET_REQUESTED' }>('/api/auth/forgot-password', { method: 'POST', body });
}

/** `POST /api/auth/reset-password` : le jeton vient du fragment du lien reçu par email (R8). */
export function resetPassword(body: { token: string; newPassword: string }): Promise<void> {
  return apiFetch<void>('/api/auth/reset-password', { method: 'POST', body });
}

/** `GET /api/me` : le serveur fait foi (R4), appelé au démarrage de chaque écran protégé. */
export function fetchMe(): Promise<Me> {
  return apiFetch<Me>('/api/me');
}

/** `POST /api/auth/logout` : un corps vide s'envoie `{}`. */
export function logout(): Promise<void> {
  return apiFetch<void>('/api/auth/logout', { method: 'POST', body: {} });
}
