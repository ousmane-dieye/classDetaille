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

const LIST = '/api/classes';

const admin: Me = {
  id: 'a1',
  email: 'direction@esp.sn',
  firstName: 'Sokhna',
  lastName: 'Fall',
  globalRole: 'ADMIN',
  emailReminders: true,
  emailAnnouncements: true,
  enrollment: null,
  membership: null,
};

async function at(handler?: (url: string, init?: RequestInit) => Response): Promise<void> {
  stubApi(handler ?? ((url) => (url === LIST ? jsonResponse(201, {}) : jsonResponse(200, {}))));
  render(
    <MemoryRouter initialEntries={['/classes/nouvelle']}>
      <SessionProvider loadMe={async () => admin}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Créer une classe' });
}

function posts(): Array<[string, RequestInit | undefined]> {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST') as Array<
    [string, RequestInit | undefined]
  >;
}

function fill(): void {
  fireEvent.change(screen.getByLabelText('Nom de la classe'), { target: { value: 'L1 Informatique' } });
  fireEvent.change(screen.getByLabelText('Niveau'), { target: { value: 'L1' } });
  fireEvent.change(screen.getByLabelText('Année scolaire'), { target: { value: '2026-2027' } });
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

describe('création d’une classe (M11, R8)', () => {
  it('demande le nom, le niveau et l’année scolaire', async () => {
    await at();

    expect(screen.getByLabelText('Nom de la classe')).toBeTruthy();
    expect(screen.getByLabelText('Niveau')).toBeTruthy();
    expect(screen.getByLabelText('Année scolaire')).toBeTruthy();
    expect(screen.getByText('Le format attendu est AAAA-AAAA.')).toBeTruthy();
  });

  it('une année mal formée est refusée sans rien envoyer', async () => {
    await at();
    fireEvent.change(screen.getByLabelText('Nom de la classe'), { target: { value: 'L1 Informatique' } });
    fireEvent.change(screen.getByLabelText('Niveau'), { target: { value: 'L1' } });
    fireEvent.change(screen.getByLabelText('Année scolaire'), { target: { value: '2026/2027' } });
    submit();

    expect(await screen.findByText("L'année scolaire prend le format AAAA-AAAA.")).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('un champ vide est refusé sans rien envoyer', async () => {
    await at();
    fireEvent.change(screen.getByLabelText('Niveau'), { target: { value: 'L1' } });
    fireEvent.change(screen.getByLabelText('Année scolaire'), { target: { value: '2026-2027' } });
    submit();

    expect(await screen.findByText('Le nom de la classe est obligatoire.')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('la création envoie les trois champs et revient à la liste', async () => {
    await at();
    fill();
    submit();

    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0] as [string, RequestInit];
    expect(url).toBe(LIST);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'L1 Informatique', level: 'L1', academicYear: '2026-2027' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Classes' })).toBeTruthy();
  });

  it('un nom déjà porté affiche le message du serveur et garde la saisie', async () => {
    await at((url, init) => {
      if (init?.method === 'POST') return serverError(409, 'CLASS_ALREADY_EXISTS');
      return jsonResponse(200, {});
    });
    fill();
    submit();

    expect(await screen.findByText('Une classe nommée ainsi existe déjà pour cette année scolaire.')).toBeTruthy();
    expect((screen.getByLabelText('Nom de la classe') as HTMLInputElement).value).toBe('L1 Informatique');
  });

  it('une information invalide du serveur nomme le formulaire à revoir', async () => {
    await at((url, init) => {
      if (init?.method === 'POST') return serverError(422, 'VALIDATION_FAILED');
      return jsonResponse(200, {});
    });
    fill();
    submit();

    expect(await screen.findByText('Certaines informations sont invalides : vérifie le formulaire.')).toBeTruthy();
  });
});
