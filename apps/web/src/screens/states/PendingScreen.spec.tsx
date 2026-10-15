import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '../../api/client';
import type { Enrollment, Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const jsonResponse = (status: number, body: unknown): Response =>
  // `Response` refuse tout corps sur 204/304 : on renvoie un corps vide.
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/auth/logout'
        ? jsonResponse(204, null)
        : jsonResponse(500, { error: { code: 'INTERNAL' }, requestId: 'inattendu' }),
    ),
  );
}

const CLASSES = { id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' };

function meWith(enrollment: Enrollment | null): Me {
  return {
    id: 'u1',
    email: 'awa.diop@esp.sn',
    firstName: 'Awa',
    lastName: 'Diop',
    globalRole: 'USER',
    emailReminders: true,
    emailAnnouncements: true,
    enrollment,
  };
}

const createdAt = new Date(2026, 9, 14, 9, 41).toISOString();

function at(path: string, loadMe: () => Promise<Me>): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider loadMe={loadMe}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const pending: Enrollment = {
  id: 'e1',
  status: 'PENDING',
  class: CLASSES,
  createdAt,
  decidedAt: null,
  decisionNote: null,
  retryAfter: null,
};

const rejected = async (): Promise<Me> => {
  throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

const unavailable = async (): Promise<Me> => {
  // 503 = mise à jour (écran « ClassePulse revient très vite », testé dans require-session.spec) :
  // ici c'est l'erreur ordinaire du serveur, avec « Réessayer ».
  throw new ApiProblem({ status: 500, code: 'INTERNAL', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('écran « Demande envoyée » (M7)', () => {
  it('rappelle la classe, l’email utilisé et la date d’envoi', async () => {
    stubApi();
    at('/etat/demande-envoyee', async () => meWith(pending));

    expect(await screen.findByRole('heading', { level: 1, name: 'Demande envoyée' })).toBeTruthy();
    expect(screen.getByText(/Ta demande pour rejoindre/)).toBeTruthy();
    expect(screen.getByText(/GIT3 · 2026-2027/)).toBeTruthy();
    expect(screen.getByText('awa.diop@esp.sn')).toBeTruthy();
    expect(screen.getByText('14 oct. à 09:41')).toBeTruthy();
    expect(screen.getByText(/Si l'email ci-dessus est faux, contacte ton délégué\./)).toBeTruthy();
  });

  it('propose de se déconnecter, ce qui ferme la session', async () => {
    stubApi();
    at('/etat/demande-envoyee', async () => meWith(pending));

    fireEvent.click(await screen.findByRole('button', { name: 'Se déconnecter' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === '/api/auth/logout')).toBe(true));
  });

  it('sans demande en cours, invite à contacter le délégué', async () => {
    stubApi();
    at('/etat/demande-envoyee', async () => meWith(null));

    expect(await screen.findByRole('heading', { level: 1, name: 'Aucune demande en attente' })).toBeTruthy();
    expect(screen.getByText(/contacte le délégué de ta classe/)).toBeTruthy();
  });

  it('un compte accepté sans classe affiche un écran de secours', async () => {
    stubApi();
    at(
      '/etat/demande-envoyee',
      async () =>
        meWith({ ...pending, status: 'ACCEPTED', class: null, decidedAt: createdAt, decisionNote: null }),
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Ta classe est prête' })).toBeTruthy();
  });

  it('sans session, renvoie vers la connexion', async () => {
    stubApi();
    at('/etat/demande-envoyee', rejected);
    expect(await screen.findByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
  });

  it('le serveur indisponible affiche l’erreur avec « Réessayer »', async () => {
    stubApi();
    const loadMe = vi.fn(unavailable);
    at('/etat/demande-envoyee', loadMe);

    expect(await screen.findByRole('heading', { level: 1, name: 'Impossible de charger ta demande' })).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Réessayer' });
    loadMe.mockClear();
    fireEvent.click(retry);
    await waitFor(() => expect(loadMe).toHaveBeenCalled());
  });
});
