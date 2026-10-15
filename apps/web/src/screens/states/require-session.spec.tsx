import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '../../api/client';
import type { Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const me: Me = {
  id: 'u1',
  email: 'awa.diop@esp.sn',
  firstName: 'Awa',
  lastName: 'Diop',
  globalRole: 'USER',
  emailReminders: true,
  emailAnnouncements: true,
  enrollment: null,
};

const makeProblem = (
  status: number,
  code: string,
  options: { retryAfterSeconds?: number | null; requestId?: string } = {},
): ApiProblem =>
  new ApiProblem({ status, code, extra: {}, requestId: options.requestId ?? 'req-8f3a21c4', retryAfterSeconds: options.retryAfterSeconds ?? null });

const rejecting =
  (problem: ApiProblem): (() => Promise<Me>) =>
  async () => {
    throw problem;
  };

function stubApi(handler: (url: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => handler(url)));
}

function mountAt(path: string, loadMe: () => Promise<Me>): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider loadMe={loadMe}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('états communs d’un écran connecté (§ 3.2, M14)', () => {
  it('401 : la connexion est demandée, puis l’écran d’origine est repris', async () => {
    let authenticated = false;
    stubApi((url) => {
      if (url === '/api/auth/login') {
        authenticated = true;
        return jsonResponse(200, me);
      }
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    mountAt('/profil', async () => {
      if (authenticated) return me;
      throw makeProblem(401, 'UNAUTHENTICATED');
    });

    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'awa@esp.sn' } });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'une phrase de passe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Profil' })).toBeTruthy();
  });

  it('503 : maintenance expliquée, avec nouvel essai automatique', async () => {
    const loadMe = vi.fn(rejecting(makeProblem(503, 'SIGNUP_UNAVAILABLE', { retryAfterSeconds: 1 })));
    mountAt('/profil', loadMe);

    expect(await screen.findByRole('heading', { level: 1, name: 'ClassePulse revient très vite' })).toBeTruthy();
    expect(screen.getByText(/On fait une mise à jour/)).toBeTruthy();
    expect(screen.getByText(/Nouvel essai automatique dans/)).toBeTruthy();
    // Le compte à rebours fini, la session se recharge sans action de la personne.
    await waitFor(() => expect(loadMe.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3500 });
  });

  it('429 : message et compte à rebours du serveur', async () => {
    mountAt('/profil', rejecting(makeProblem(429, 'TOO_MANY_ATTEMPTS', { retryAfterSeconds: 45 })));

    expect(await screen.findByText(/^Trop de tentatives\./)).toBeTruthy();
    expect(screen.getByText('00:45')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
  });

  it('404 : le même écran que les autres éléments introuvables', async () => {
    mountAt('/profil', rejecting(makeProblem(404, 'NOT_FOUND')));

    expect(
      await screen.findByRole('heading', { level: 1, name: "Cet élément n'existe pas ou n'est plus disponible" }),
    ).toBeTruthy();
    expect(screen.getByText(/Il a peut-être été supprimé/)).toBeTruthy();
  });

  it('erreur : la référence est affichée pour l’assistance', async () => {
    mountAt('/profil', rejecting(makeProblem(500, 'INTERNAL')));

    expect(await screen.findByText('Référence : req-8f3a21c4')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
  });
});
