import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Enrollment, Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const jsonResponse = (status: number, body: unknown): Response =>
  // `Response` refuse tout corps sur 204/304 : on renvoie un corps vide.
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(handler?: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) =>
      handler
        ? handler(url, init)
        : url === '/api/auth/logout'
          ? jsonResponse(204, null)
          : jsonResponse(200, {}),
    ),
  );
}

const posts = (): Array<[string, RequestInit | undefined]> =>
  vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST') as Array<
    [string, RequestInit | undefined]
  >;

const CLASSES = { id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' };
const decidedAt = new Date(2026, 9, 14, 9, 41).toISOString();
const retryAfter = new Date(2026, 9, 15, 9, 41).toISOString();

function refusedWith(overrides: Partial<Enrollment>): Enrollment {
  return {
    id: 'e1',
    status: 'REFUSED',
    class: CLASSES,
    createdAt: decidedAt,
    decidedAt,
    decisionNote: 'Tu es inscrite en GIT2, rejoins plutôt cette classe.',
    retryAfter,
    ...overrides,
  };
}

function meWith(enrollment: Enrollment): Me {
  return {
    id: 'u1',
    email: 'awa.diop@esp.sn',
    firstName: 'Awa',
    lastName: 'Diop',
    globalRole: 'USER',
    emailReminders: true,
    emailAnnouncements: true,
    enrollment,
    membership: null,
  };
}

function at(path: string, me: Me, loadMe?: () => Promise<Me>): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider loadMe={loadMe ?? (async () => me)}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('écran « Demande refusée » (M7)', () => {
  it('affiche le motif entre guillemets, la date de nouvelle demande et les actions', async () => {
    stubApi();
    at('/etat/demande-refusee', meWith(refusedWith({})));

    expect(await screen.findByRole('heading', { level: 1, name: 'Demande refusée' })).toBeTruthy();
    expect(screen.getByText(/GIT3 · 2026-2027/)).toBeTruthy();
    expect(screen.getByText('Motif indiqué par le délégué')).toBeTruthy();
    expect(screen.getByText('« Tu es inscrite en GIT2, rejoins plutôt cette classe. »')).toBeTruthy();
    expect(screen.getByText(/à partir du 15 oct\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeTruthy();
  });

  it('renvoie vers l’inscription avec « Demander une autre classe »', async () => {
    stubApi();
    at('/etat/demande-refusee', meWith(refusedWith({})));

    fireEvent.click(await screen.findByRole('link', { name: 'Demander une autre classe' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Créer ton compte' })).toBeTruthy();
  });

  it('masque le bloc de motif quand le délégué n’en a pas indiqué', async () => {
    stubApi();
    at('/etat/demande-refusee', meWith(refusedWith({ decisionNote: null, retryAfter: null })));

    expect(await screen.findByRole('heading', { level: 1, name: 'Demande refusée' })).toBeTruthy();
    expect(screen.queryByText('Motif indiqué par le délégué')).toBeNull();
    expect(screen.queryByText(/à partir du/)).toBeNull();
  });

  it('hors refus, renvoie vers la demande en attente', async () => {
    stubApi();
    at(
      '/etat/demande-refusee',
      meWith({ ...refusedWith({}), status: 'PENDING', decisionNote: null, retryAfter: null }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Demande envoyée' })).toBeTruthy();
  });

  it('« Refaire ta demande » renvoie la même classe au serveur et affiche l’état en attente (R16)', async () => {
    stubApi();
    const refused = meWith(refusedWith({}));
    const pending = meWith({
      ...refusedWith({}),
      status: 'PENDING',
      decidedAt: null,
      decisionNote: null,
      retryAfter: null,
    });
    // Le profil change d'état une fois la re-demande acceptée par le serveur.
    let loads = 0;
    at('/etat/demande-refusee', refused, async () => {
      loads += 1;
      return loads === 1 ? refused : pending;
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Refaire ta demande' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Demande envoyée' })).toBeTruthy();
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0] as [string, RequestInit];
    expect(url).toBe('/api/me/enrollment');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ classId: 'c1' });
  });

  it('le délai de 24 h nomme la date du serveur, sans compte à rebours (R16)', async () => {
    stubApi((url) =>
      url === '/api/me/enrollment'
        ? jsonResponse(400, {
            error: { code: 'ENROLLMENT_RETRY_PENDING', retryAfter: '2026-10-16T12:00:00.000Z' },
            requestId: 'r',
          })
        : jsonResponse(200, {}),
    );
    at('/etat/demande-refusee', meWith(refusedWith({})));

    fireEvent.click(await screen.findByRole('button', { name: 'Refaire ta demande' }));

    expect(await screen.findByText('Tu pourras refaire ta demande à partir du 16 octobre 2026.')).toBeTruthy();
    expect(document.querySelector('.cp-countdown')).toBeNull();
  });

  it('le délai sans date retombe sur les 24 h, jamais sur un code brut', async () => {
    stubApi((url) =>
      url === '/api/me/enrollment'
        ? jsonResponse(400, { error: { code: 'ENROLLMENT_RETRY_PENDING' }, requestId: 'r' })
        : jsonResponse(200, {}),
    );
    at('/etat/demande-refusee', meWith(refusedWith({})));

    fireEvent.click(await screen.findByRole('button', { name: 'Refaire ta demande' }));

    expect(await screen.findByText('Tu pourras refaire ta demande dans 24 heures.')).toBeTruthy();
  });

  it('un compte déjà membre affiche le message sans changer d’écran (R16)', async () => {
    stubApi((url) =>
      url === '/api/me/enrollment'
        ? jsonResponse(409, { error: { code: 'ALREADY_MEMBER' }, requestId: 'r' })
        : jsonResponse(200, {}),
    );
    at('/etat/demande-refusee', meWith(refusedWith({})));

    fireEvent.click(await screen.findByRole('button', { name: 'Refaire ta demande' }));

    expect(await screen.findByText('Cette personne est déjà membre de cette classe.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Demande refusée' })).toBeTruthy();
  });
});
