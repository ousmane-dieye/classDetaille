import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClassMember, Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const jsonResponse = (status: number, body: unknown): Response =>
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const serverError = (status: number, code: string): Response =>
  jsonResponse(status, { error: { code }, requestId: 'r1' });

function stubApi(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

const LIST = '/api/classes/c1/members';

const MEMBERS: ClassMember[] = [
  { userId: 'u1', firstName: 'Awa', lastName: 'Diop', email: 'a•••••@esp.sn', role: 'STUDENT', joinedAt: '2026-10-01T09:00:00.000Z' },
  { userId: 'u2', firstName: 'Mariama', lastName: 'Ba', email: 'm•••••@esp.sn', role: 'DELEGATE', joinedAt: '2026-10-01T09:00:00.000Z' },
];

const me: Me = {
  id: 'u2',
  email: 'delegue@esp.sn',
  firstName: 'Mariama',
  lastName: 'Ba',
  globalRole: 'USER',
  emailReminders: true,
  emailAnnouncements: true,
  enrollment: null,
  membership: { classId: 'c1', classLabel: 'GIT3 · L3 · 2026-2027', role: 'DELEGATE' },
};

/**
 * @param members la liste renvoyée par le serveur
 * @param handler remplace le serveur par défaut (200 sur la liste, 204 partout ailleurs)
 */
async function at(members: ClassMember[] = MEMBERS, handler?: (url: string, init?: RequestInit) => Response): Promise<void> {
  stubApi(
    handler ??
      ((url, init) =>
        url === LIST ? jsonResponse(200, members) : jsonResponse(200, init?.method === 'DELETE' ? { status: 'REMOVED' } : {})),
  );
  render(
    <MemoryRouter initialEntries={['/classes/c1/membres']}>
      <SessionProvider loadMe={async () => me}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Membres' });
  await waitFor(() => expect(screen.queryByText('Chargement…')).toBeNull());
  return Promise.resolve();
}

function posts(): Array<[string, RequestInit | undefined]> {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE' || init?.method === 'POST') as Array<
    [string, RequestInit | undefined]
  >;
}

function sent(index: number): { url: string; body: unknown } | null {
  const call = posts()[index];
  if (!call) return null;
  return { url: call[0], body: JSON.parse(String(call[1]?.body)) };
}

function submit(): void {
  const form = document.querySelector('form');
  if (!form) throw new Error('formulaire absent');
  fireEvent.submit(form);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('écran des membres (M9)', () => {
  it('liste les membres avec leur email et un badge « Délégué »', async () => {
    await at();

    expect(screen.getByText('a•••••@esp.sn')).toBeTruthy();
    expect(screen.getByText('m•••••@esp.sn')).toBeTruthy();
    expect(screen.getAllByText('Délégué')).toHaveLength(1);
    expect(screen.getAllByText('Étudiant')).toHaveLength(1);
  });

  it('le retrait demande confirmation nommant la personne, avec motif facultatif', async () => {
    await at();
    fireEvent.click(screen.getByRole('button', { name: 'Retirer Awa Diop' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Retirer Awa Diop de la classe ?' })).toBeTruthy();
    expect(screen.getByLabelText('Motif')).toBeTruthy();
    expect(screen.getByText('Le motif est facultatif : il sera envoyé à la personne.')).toBeTruthy();
  });

  it('le motif saisi part avec la suppression, sans motif le corps reste vide', async () => {
    await at();
    fireEvent.click(screen.getByRole('button', { name: 'Retirer Awa Diop' }));
    await screen.findByRole('heading', { level: 2, name: 'Retirer Awa Diop de la classe ?' });
    fireEvent.change(screen.getByLabelText('Motif'), { target: { value: 'Ne vient plus en cours.' } });
    submit();

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(sent(0)).toEqual({ url: `${LIST}/u1`, body: { note: 'Ne vient plus en cours.' } });
  });

  it('un délégué ne retire pas un autre délégué : le bouton n’est pas là', async () => {
    await at();

    expect(screen.getByRole('button', { name: 'Retirer Awa Diop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retirer Mariama Ba' })).toBeNull();
  });

  it('un administrateur retire qui que ce soit', async () => {
    stubApi((url) => (url === LIST ? jsonResponse(200, MEMBERS) : jsonResponse(200, {})));
    const admin: Me = { ...me, globalRole: 'ADMIN', membership: null };
    render(
      <MemoryRouter initialEntries={['/classes/c1/membres']}>
        <SessionProvider loadMe={async () => admin}>
          <AppRoutes />
        </SessionProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Membres' });
    await waitFor(() => expect(screen.queryByText('Chargement…')).toBeNull());

    expect(screen.getByRole('button', { name: 'Retirer Mariama Ba' })).toBeTruthy();
  });

  it('le refus du serveur s’affiche et garde la liste en place', async () => {
    await at(MEMBERS, (url, init) =>
      init?.method === 'DELETE' ? serverError(403, 'DELEGATE_FORBIDDEN') : jsonResponse(200, MEMBERS),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retirer Awa Diop' }));
    await screen.findByRole('heading', { level: 2, name: 'Retirer Awa Diop de la classe ?' });
    submit();

    expect(await screen.findByText('Seuls un délégué de la classe ou un administrateur peuvent faire cela.')).toBeTruthy();
    expect(screen.getByText('a•••••@esp.sn')).toBeTruthy();
  });

  it('sans membre, affiche l’état vide', async () => {
    await at([]);
    expect(screen.getByText('Aucun membre dans cette classe.')).toBeTruthy();
  });

  it('un échec du serveur affiche son message et propose « Réessayer »', async () => {
    stubApi(() => serverError(500, 'INTERNAL'));
    render(
      <MemoryRouter initialEntries={['/classes/c1/membres']}>
        <SessionProvider loadMe={async () => me}>
          <AppRoutes />
        </SessionProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Membres' });

    expect(await screen.findByText('Une erreur est survenue. Réessaie.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
  });
});
