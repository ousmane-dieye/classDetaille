import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me, Subject } from '../../api/types';
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

const LIST = '/api/classes/c1/subjects';

const SUBJECTS: Subject[] = [
  { id: 's1', name: 'Algorithmique', createdAt: '2026-10-01T09:00:00.000Z' },
  { id: 's2', name: 'Bases de données', createdAt: '2026-10-02T09:00:00.000Z' },
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
 * @param subjects la liste renvoyée par le serveur
 * @param handler remplace le serveur par défaut (200 sur la liste, `{}` partout ailleurs)
 */
async function at(subjects: Subject[] = SUBJECTS, handler?: (url: string, init?: RequestInit) => Response): Promise<void> {
  stubApi(handler ?? ((url) => (url === LIST ? jsonResponse(200, subjects) : jsonResponse(200, {}))));
  render(
    <MemoryRouter initialEntries={['/classes/c1/matieres']}>
      <SessionProvider loadMe={async () => me}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Matières' });
  await waitFor(() => expect(screen.queryByText('Chargement…')).toBeNull());
}

function writes(): Array<[string, RequestInit | undefined]> {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'DELETE') as Array<
    [string, RequestInit | undefined]
  >;
}

function sent(index: number): { url: string; body: unknown } | null {
  const call = writes()[index];
  if (!call) return null;
  return { url: call[0], body: JSON.parse(String(call[1]?.body)) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('écran des matières (R12, M9)', () => {
  it('liste les matières de la classe', async () => {
    await at();

    expect(screen.getByText('Algorithmique')).toBeTruthy();
    expect(screen.getByText('Bases de données')).toBeTruthy();
  });

  it('saisir un nom puis valider ajoute la matière', async () => {
    await at();
    fireEvent.change(screen.getByLabelText('Nom de la matière'), { target: { value: 'Réseaux' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter la matière' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(sent(0)).toEqual({ url: LIST, body: { name: 'Réseaux' } });
  });

  it('la matière ajoutée est confirmée par un retour temporaire nommant la matière', async () => {
    await at();
    fireEvent.change(screen.getByLabelText('Nom de la matière'), { target: { value: 'Réseaux' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter la matière' }));

    expect(await screen.findByText('La matière « Réseaux » a été ajoutée.')).toBeTruthy();
    // La saisie ne repart qu'une fois la matière posée.
    expect((screen.getByLabelText('Nom de la matière') as HTMLInputElement).value).toBe('');
  });

  it('une matière déjà présente affiche le message du serveur et garde la saisie', async () => {
    await at(SUBJECTS, (url, init) => {
      if (init?.method === 'POST') return serverError(409, 'SUBJECT_ALREADY_EXISTS');
      if (url === LIST) return jsonResponse(200, SUBJECTS);
      return jsonResponse(200, {});
    });
    fireEvent.change(screen.getByLabelText('Nom de la matière'), { target: { value: 'Algorithmique' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter la matière' }));

    expect(await screen.findByText('Cette matière existe déjà dans la classe.')).toBeTruthy();
    expect((screen.getByLabelText('Nom de la matière') as HTMLInputElement).value).toBe('Algorithmique');
  });

  it('supprimer demande confirmation nommant la matière', async () => {
    await at();
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Algorithmique' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Supprimer la matière Algorithmique ?' })).toBeTruthy();
    expect(screen.getByText(/La matière disparaît de/)).toBeTruthy();
  });

  it('la confirmation part au serveur', async () => {
    await at();
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Algorithmique' }));
    await screen.findByRole('heading', { level: 2, name: 'Supprimer la matière Algorithmique ?' });
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la matière' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(sent(0)).toEqual({ url: `${LIST}/s1`, body: {} });
  });

  it('la suppression réussie confirme par un retour temporaire, la fenêtre refermée', async () => {
    await at();
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Algorithmique' }));
    await screen.findByRole('heading', { level: 2, name: 'Supprimer la matière Algorithmique ?' });
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la matière' }));

    expect(await screen.findByText('La matière « Algorithmique » a été supprimée.')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Supprimer la matière Algorithmique ?' })).toBeNull();
  });

  it('deux confirmations rapprochées n’envoient qu’une seule suppression', async () => {
    await at();
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Algorithmique' }));
    await screen.findByRole('heading', { level: 2, name: 'Supprimer la matière Algorithmique ?' });
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la matière' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la matière' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
  });

  it('une matière encore utilisée affiche la raison et garde la liste', async () => {
    await at(SUBJECTS, (url, init) => {
      if (init?.method === 'DELETE') return serverError(409, 'SUBJECT_IN_USE');
      if (url === LIST) return jsonResponse(200, SUBJECTS);
      return jsonResponse(200, {});
    });
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Algorithmique' }));
    await screen.findByRole('heading', { level: 2, name: 'Supprimer la matière Algorithmique ?' });
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la matière' }));

    expect(await screen.findByText('Cette matière sert encore à un devoir ou à une ressource : retire-les d’abord.')).toBeTruthy();
    expect(screen.getByText('Algorithmique')).toBeTruthy();
  });

  it('sans matière, affiche l’état vide', async () => {
    await at([]);
    expect(screen.getByText('Aucune matière pour le moment.')).toBeTruthy();
  });

  it('un échec du serveur affiche son message et propose « Réessayer »', async () => {
    stubApi(() => serverError(500, 'INTERNAL'));
    render(
      <MemoryRouter initialEntries={['/classes/c1/matieres']}>
        <SessionProvider loadMe={async () => me}>
          <AppRoutes />
        </SessionProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Matières' });

    expect(await screen.findByText('Une erreur est survenue. Réessaie.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
  });
});
