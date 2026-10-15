import { apiFetch } from './client';
import type { ClassSummary, Me } from './types';

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

/** `GET /api/classes/active` : classes à choisir à l'inscription (publique). */
export function listActiveClasses(): Promise<ClassSummary[]> {
  return apiFetch<ClassSummary[]>('/api/classes/active');
}

/** `GET /api/me` : le serveur fait foi (R4), appelé au démarrage de chaque écran protégé. */
export function fetchMe(): Promise<Me> {
  return apiFetch<Me>('/api/me');
}

/** `POST /api/auth/logout` : un corps vide s'envoie `{}`. */
export function logout(): Promise<void> {
  return apiFetch<void>('/api/auth/logout', { method: 'POST', body: {} });
}
