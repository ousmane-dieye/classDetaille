import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '../../api/client';
import type { Me, Session } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const jsonResponse = (status: number, body: unknown): Response =>
  // `Response` refuse tout corps sur 204/304 : on renvoie un corps vide.
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/109.0 Firefox/119.0';

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

const CURRENT: Session = {
  id: 's1',
  createdAt: '2026-10-12T10:00:00.000Z',
  lastSeenAt: '2026-10-15T09:41:00.000Z',
  userAgent: CHROME_WINDOWS,
  current: true,
};

const OTHER: Session = {
  id: 's2',
  createdAt: '2026-10-02T18:20:00.000Z',
  lastSeenAt: '2026-10-14T22:10:00.000Z',
  userAgent: FIREFOX_ANDROID,
  current: false,
};

const unauthenticated = async (): Promise<Me> => {
  throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

function mountAt(loadMe: () => Promise<Me> = async () => me): void {
  render(
    <MemoryRouter initialEntries={['/profil/sessions']}>
      <SessionProvider loadMe={loadMe}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const okHandler = (): Response => jsonResponse(200, [CURRENT, OTHER]);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('sessions actives (§ 3.4, M14)', () => {
  it('liste les sessions : appareil, activité, ouverture et appareil courant', async () => {
    stubApi((url) => (url === '/api/me/sessions' ? okHandler() : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' })));
    mountAt();

    expect(await screen.findByRole('heading', { level: 1, name: 'Sessions actives' })).toBeTruthy();
    expect(await screen.findByText('Chrome · Windows')).toBeTruthy();
    expect(screen.getByText('Firefox · Android')).toBeTruthy();
    expect(screen.getByText('actif maintenant')).toBeTruthy();
    expect(screen.getByText(/^Dernière activité le /)).toBeTruthy();
    expect(screen.getAllByText(/^Session ouverte le /)).toHaveLength(2);
    // Seule la session courante porte le badge « Cet appareil ».
    expect(screen.getAllByText('Cet appareil')).toHaveLength(1);
  });

  it('déconnecte les autres appareils après confirmation, et annonce le nombre', async () => {
    const urls: string[] = [];
    let revoked = 0;
    stubApi((url) => {
      urls.push(String(url));
      if (url === '/api/me/sessions') return okHandler();
      if (url === '/api/me/sessions/revoke-others') {
        revoked += 1;
        return jsonResponse(200, { revoked });
      }
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    mountAt();

    fireEvent.click(await screen.findByRole('button', { name: 'Déconnecter les autres appareils' }));
    expect(screen.getByText('Déconnecter les autres appareils ?')).toBeTruthy();

    // Annuler referme la question sans rien demander au serveur.
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByText('Déconnecter les autres appareils ?')).toBeNull();
    expect(urls.filter((u) => u === '/api/me/sessions/revoke-others')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Déconnecter les autres appareils' }));
    fireEvent.click(screen.getByRole('button', { name: 'Déconnecter' }));

    expect(await screen.findByText('1 appareil déconnecté.')).toBeTruthy();
    expect(urls.filter((u) => u === '/api/me/sessions/revoke-others')).toHaveLength(1);
  });

  it('401 sur la liste : la session a pris fin, retour à la connexion', async () => {
    stubApi((url) =>
      url === '/api/me/sessions'
        ? jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mountAt();

    expect(await screen.findByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
  });

  it('chargement : un squelette paraît au-delà de 300 ms', async () => {
    stubApi(() => new Promise<Response>(() => {}) as unknown as Response);
    mountAt();

    await screen.findByRole('heading', { level: 1, name: 'Sessions actives' });
    await waitFor(() => expect(document.querySelector('.cp-skeleton')).not.toBeNull());
  });

  it('liste vide : le cas est dit, sans faux appareil', async () => {
    stubApi((url) => (url === '/api/me/sessions' ? jsonResponse(200, []) : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' })));
    mountAt();

    expect(await screen.findByText('Aucune session active.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Déconnecter les autres appareils' })).toBeNull();
  });

  it('erreur serveur : message et bouton « Réessayer » qui recharge', async () => {
    let fail = true;
    stubApi((url) => {
      if (url !== '/api/me/sessions') return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
      return fail ? jsonResponse(500, { error: { code: 'INTERNAL' }, requestId: 'r' }) : okHandler();
    });
    mountAt();

    expect((await screen.findByRole('alert')).textContent).toBe('Une erreur est survenue. Réessaie.');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(await screen.findByText('Chrome · Windows')).toBeTruthy();
  });

  it('sans session, renvoie vers la connexion', async () => {
    stubApi((url) => (url === '/api/me/logout' ? jsonResponse(404, { error: { code: 'NOT_FOUND' }, requestId: 'r' }) : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' })));
    mountAt(unauthenticated);

    expect(await screen.findByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
  });
});
