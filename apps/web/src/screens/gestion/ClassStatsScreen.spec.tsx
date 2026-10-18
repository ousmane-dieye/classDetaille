import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../../api/types';
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

const DETAIL = '/api/classes/c1';

const detail = {
  id: 'c1',
  name: 'GIT3',
  level: 'L3',
  academicYear: '2026-2027',
  status: 'ACTIVE',
  archivedAt: null,
  stats: { members: 42, pendingRequests: 3, decidedRequests: 17 },
};

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
 * @param handler remplace le serveur par défaut (200 sur la fiche, `{}` partout ailleurs)
 */
async function at(path = '/classes/c1/statistiques', handler?: (url: string, init?: RequestInit) => Response): Promise<void> {
  stubApi(handler ?? ((url) => (url === DETAIL ? jsonResponse(200, detail) : jsonResponse(200, {}))));
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider loadMe={async () => me}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Statistiques' });
  await waitFor(() => expect(screen.queryByText('Chargement…')).toBeNull());
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('écran des statistiques (M9, R11)', () => {
  it('annonce les trois chiffres du serveur, sans les calculer côté client', async () => {
    await at();

    expect(screen.getByRole('heading', { level: 1, name: 'Statistiques' })).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.getByText('Membres actifs')).toBeTruthy();
    expect(screen.getByText('Demandes en attente')).toBeTruthy();
    expect(screen.getByText('Demandes traitées')).toBeTruthy();
  });

  it('les demandes en attente renvoient vers la file', async () => {
    await at();

    const link = screen.getByRole('link', { name: '3 Demandes en attente' });
    expect(link.getAttribute('href')).toBe('/classes/c1/demandes');
  });

  it('une classe inconnue ou d’un autre compte affiche le même 404 qu’une classe inexistante', async () => {
    await at('/classes/c1/statistiques', (url) =>
      url === DETAIL ? serverError(404, 'CLASS_NOT_FOUND') : jsonResponse(200, {}),
    );

    expect(await screen.findByText('Cette classe n’existe pas ou n’est plus disponible.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Retour à mon profil' })).toBeTruthy();
  });

  it('un échec du serveur affiche son message et propose « Réessayer »', async () => {
    let failing = true;
    await at('/classes/c1/statistiques', (url) => {
      if (url !== DETAIL) return jsonResponse(200, {});
      return failing ? serverError(500, 'INTERNAL') : jsonResponse(200, detail);
    });

    expect(await screen.findByText('Une erreur est survenue. Réessaie.')).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('42')).toBeTruthy();
  });

  it('la navigation partagée nomme les quatre sections et marque la courante', async () => {
    await at();

    const nav = screen.getByRole('navigation', { name: 'Sections de la classe' });
    const links = screen.getAllByRole('link');
    const names = links.map((l) => l.textContent).filter((t) => ['Demandes', 'Membres', 'Matières', 'Statistiques'].includes(t ?? ''));
    expect(names).toHaveLength(4);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('Statistiques');
  });
});
