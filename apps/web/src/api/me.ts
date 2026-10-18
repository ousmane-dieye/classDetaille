import { apiFetch } from './client';
import type { Enrollment } from './types';

/** `POST /api/me/enrollment` (201, R16) : re-demande d'adhésion d'un compte existant. */
export function createEnrollment(classId: string): Promise<Enrollment> {
  return apiFetch<Enrollment>('/api/me/enrollment', { method: 'POST', body: { classId } });
}
