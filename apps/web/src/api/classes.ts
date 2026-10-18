import { apiFetch } from './client';
import type {
  ClassAdminSummary,
  ClassDetail,
  ClassMember,
  Delegate,
  EnrollmentRequest,
  Subject,
  Transfer,
  TransferBatch,
} from './types';

/**
 * Client des routes du lot 2 (§ 0.5 « Portée ») : une fonction par route, la méthode et le corps
 * exacts attendus par l'API. Les routes sans champ envoient `{}` — un objet vide, jamais `undefined`,
 * pour que Fastify reçoive un corps JSON analysable.
 *
 * Aucune logique d'interdiction ici : elle vit d'abord en base (déclencheurs), puis dans l'API.
 * Cette couche ne fait que porter la requête et laisser l'erreur remonter (`ApiProblem`).
 */

/** `GET /api/classes/:classId/requests` (M9) : la file d'attente, du plus ancien au plus récent. */
export function listRequests(classId: string): Promise<EnrollmentRequest[]> {
  return apiFetch<EnrollmentRequest[]>(`/api/classes/${classId}/requests`);
}

/** `POST /api/classes/:classId/requests/:requestId/accept` (M9) : décision définitive, sans motif. */
export function acceptRequest(classId: string, requestId: string): Promise<{ status: 'ACCEPTED'; decidedAt: string }> {
  return apiFetch(`/api/classes/${classId}/requests/${requestId}/accept`, { method: 'POST', body: {} });
}

/** `POST /api/classes/:classId/requests/:requestId/refuse` (M9) : motif facultatif, borné à 500 caractères. */
export function refuseRequest(classId: string, requestId: string, note?: string): Promise<void> {
  return apiFetch<void>(`/api/classes/${classId}/requests/${requestId}/refuse`, {
    method: 'POST',
    body: note === undefined ? {} : { note },
  });
}

/** `GET /api/classes/:classId/members` (M9) : emails visibles du délégué et de l'administrateur. */
export function listMembers(classId: string): Promise<ClassMember[]> {
  return apiFetch<ClassMember[]>(`/api/classes/${classId}/members`);
}

/** `DELETE /api/classes/:classId/members/:userId` (M9) : retrait daté et motivé, jamais une suppression. */
export function removeMember(classId: string, userId: string, note?: string): Promise<void> {
  return apiFetch<void>(`/api/classes/${classId}/members/${userId}`, {
    method: 'DELETE',
    body: note === undefined ? {} : { note },
  });
}

/** `POST /api/classes/:classId/delegates` (M12) : la limite de deux délégués est portée par la base. */
export function appointDelegate(classId: string, userId: string): Promise<Delegate> {
  return apiFetch<Delegate>(`/api/classes/${classId}/delegates`, { method: 'POST', body: { userId } });
}

/** `DELETE /api/classes/:classId/delegates/:userId` (M12) : le rôle revient à `STUDENT`. */
export function revokeDelegate(classId: string, userId: string): Promise<Delegate> {
  return apiFetch<Delegate>(`/api/classes/${classId}/delegates/${userId}`, { method: 'DELETE', body: {} });
}

/** `GET /api/classes/:classId/subjects` (R12, M9) : matières de la classe, ordre de création. */
export function listSubjects(classId: string): Promise<Subject[]> {
  return apiFetch<Subject[]>(`/api/classes/${classId}/subjects`);
}

/** `POST /api/classes/:classId/subjects` (R12) : unicité par classe portée par un index. */
export function createSubject(classId: string, name: string): Promise<Subject> {
  return apiFetch<Subject>(`/api/classes/${classId}/subjects`, { method: 'POST', body: { name } });
}

/** `DELETE /api/classes/:classId/subjects/:subjectId` (R12) : la base refuse si la matière sert encore. */
export function deleteSubject(classId: string, subjectId: string): Promise<void> {
  return apiFetch<void>(`/api/classes/${classId}/subjects/${subjectId}`, { method: 'DELETE', body: {} });
}

/** `POST /api/users/:userId/transfer` (M13, R7) : mot de passe récent exigé par l'API. */
export function transferMember(userId: string, toClassId: string): Promise<Transfer> {
  return apiFetch<Transfer>(`/api/users/${userId}/transfer`, { method: 'POST', body: { toClassId } });
}

/** `POST /api/classes/:classId/transfers` (M13, R7) : `classId` est la destination, 200 au maximum par appel. */
export function transferBatch(classId: string, userIds: string[]): Promise<TransferBatch> {
  return apiFetch<TransferBatch>(`/api/classes/${classId}/transfers`, { method: 'POST', body: { userIds } });
}

/** `GET /api/classes` (M11) : toutes les classes, archivées incluses — administrateurs seulement. */
export function listClasses(): Promise<ClassAdminSummary[]> {
  return apiFetch<ClassAdminSummary[]>('/api/classes');
}

/** `GET /api/classes/:classId` (M12, R11) : fiche et statistiques. Membre de la classe ou administrateur, sinon 404. */
export function getClassDetail(classId: string): Promise<ClassDetail> {
  return apiFetch<ClassDetail>(`/api/classes/${classId}`);
}
