import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest } from './client';
import {
  acceptRequest,
  appointDelegate,
  createSubject,
  deleteSubject,
  getClassDetail,
  listClasses,
  listMembers,
  listRequests,
  listSubjects,
  refuseRequest,
  removeMember,
  revokeDelegate,
  transferBatch,
  transferMember,
} from './classes';

vi.mock('./client', () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

const CLASS = 'c1';
const USER = 'u1';
const REQUEST = 'r1';
const SUBJECT = 's1';

type Case = [name: string, call: () => Promise<unknown>, args: unknown[]];

/**
 * Chaque route du lot 2 porte sa méthode et son corps exacts. Les routes sans champ envoient `{}`
 * (un objet vide) : `undefined` ne serait pas un corps JSON, et l'API lit le corps pour le valider.
 */
const ROUTES: Case[] = [
  ['GET /api/classes/:classId/requests', () => listRequests(CLASS), [`/api/classes/${CLASS}/requests`]],
  [
    'POST /api/classes/:classId/requests/:requestId/accept',
    () => acceptRequest(CLASS, REQUEST),
    [`/api/classes/${CLASS}/requests/${REQUEST}/accept`, { method: 'POST', body: {} }],
  ],
  [
    'POST /api/classes/:classId/requests/:requestId/refuse (sans motif)',
    () => refuseRequest(CLASS, REQUEST),
    [`/api/classes/${CLASS}/requests/${REQUEST}/refuse`, { method: 'POST', body: {} }],
  ],
  [
    'POST /api/classes/:classId/requests/:requestId/refuse (avec motif)',
    () => refuseRequest(CLASS, REQUEST, 'Classe complète'),
    [`/api/classes/${CLASS}/requests/${REQUEST}/refuse`, { method: 'POST', body: { note: 'Classe complète' } }],
  ],
  ['GET /api/classes/:classId/members', () => listMembers(CLASS), [`/api/classes/${CLASS}/members`]],
  [
    'DELETE /api/classes/:classId/members/:userId',
    () => removeMember(CLASS, USER),
    [`/api/classes/${CLASS}/members/${USER}`, { method: 'DELETE', body: {} }],
  ],
  [
    'DELETE /api/classes/:classId/members/:userId (avec motif)',
    () => removeMember(CLASS, USER, 'Ne vient plus en cours'),
    [`/api/classes/${CLASS}/members/${USER}`, { method: 'DELETE', body: { note: 'Ne vient plus en cours' } }],
  ],
  [
    'POST /api/classes/:classId/delegates',
    () => appointDelegate(CLASS, USER),
    [`/api/classes/${CLASS}/delegates`, { method: 'POST', body: { userId: USER } }],
  ],
  [
    'DELETE /api/classes/:classId/delegates/:userId',
    () => revokeDelegate(CLASS, USER),
    [`/api/classes/${CLASS}/delegates/${USER}`, { method: 'DELETE', body: {} }],
  ],
  ['GET /api/classes/:classId/subjects', () => listSubjects(CLASS), [`/api/classes/${CLASS}/subjects`]],
  [
    'POST /api/classes/:classId/subjects',
    () => createSubject(CLASS, 'Algorithmique'),
    [`/api/classes/${CLASS}/subjects`, { method: 'POST', body: { name: 'Algorithmique' } }],
  ],
  [
    'DELETE /api/classes/:classId/subjects/:subjectId',
    () => deleteSubject(CLASS, SUBJECT),
    [`/api/classes/${CLASS}/subjects/${SUBJECT}`, { method: 'DELETE', body: {} }],
  ],
  [
    'POST /api/users/:userId/transfer',
    () => transferMember(USER, CLASS),
    [`/api/users/${USER}/transfer`, { method: 'POST', body: { toClassId: CLASS } }],
  ],
  [
    'POST /api/classes/:classId/transfers',
    () => transferBatch(CLASS, [USER]),
    [`/api/classes/${CLASS}/transfers`, { method: 'POST', body: { userIds: [USER] } }],
  ],
  ['GET /api/classes', () => listClasses(), ['/api/classes']],
  ['GET /api/classes/:classId', () => getClassDetail(CLASS), [`/api/classes/${CLASS}`]],
];

describe('api classes (lot 2)', () => {
  it.each(ROUTES)('%s : bon appel de route', async (_name, call, expected) => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({});
    await call();
    expect(vi.mocked(apiFetch).mock.calls).toHaveLength(1);
    expect(vi.mocked(apiFetch).mock.calls[0]).toEqual(expected);
  });

  it('une route sans champ envoie un objet vide, jamais un corps absent', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({});
    await refuseRequest(CLASS, REQUEST);
    await removeMember(CLASS, USER);
    await revokeDelegate(CLASS, USER);
    // `body` présent (et non `undefined`) : sinon aucun `Content-Type` ne part et l'API n'a rien à valider.
    expect(vi.mocked(apiFetch).mock.calls.map(([, init]) => (init as ApiRequest | undefined)?.body)).toEqual([{}, {}, {}]);
  });
});
