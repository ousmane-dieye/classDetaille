import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClassAdminSummary, Me } from '../../api/types';
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

const CLASSES: ClassAdminSummary[] = [
  { id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027', status: 'ACTIVE', membersCount: 42 },
  { id: 'c2', name: 'GIT2', level: 'L2', academicYear: '2025-2026', status: 'ARCHIVED', membersCount: 38 },
];

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

/**
 * @param handler remplace le serveur par défaut (200 sur la liste, `{}` partout ailleurs)
 */
async function at(handler?: (url: string, init?: RequestInit) => Response, me: Me = admin): Promise<void> {
  stubApi(handler ?? ((url) => (url === LIST ? jsonResponse(200, CLASSES) : jsonResponse(200, {}))));
  render(
    <MemoryRouter initialEntries={['/classes']}>
      <SessionProvider loadMe={async () => me}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Classes' });
  await waitFor(() => expect(screen.queryByText('Chargement…')).toBeNull());
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('liste des classes (M11)', () => {
  it('montre le nom, le niveau, l’année et l’effectif de chaque classe', async () => {
    await at();

    expect(screen.getByText('GIT3')).toBeTruthy();
    expect(screen.getByText('L3 · 2026-2027')).toBeTruthy();
    expect(screen.getByText('42 étudiants')).toBeTruthy();
    expect(screen.getByText('GIT2')).toBeTruthy();
  });

  it('une classe archivée porte le badge « Lecture seule »', async () => {
    await at();

    expect(screen.getAllByText('Lecture seule')).toHaveLength(1);
    expect(screen.getByText('38 étudiants')).toBeTruthy();
  });

  it('chaque ligne ouvre la fiche de sa classe', async () => {
    await at();

    expect(screen.getByRole('link', { name: /GIT3/ }).getAttribute('href')).toBe('/classes/c1');
    expect(screen.getByRole('link', { name: /GIT2/ }).getAttribute('href')).toBe('/classes/c2');
  });

  it('le bouton « Créer une classe » ouvre le formulaire', async () => {
    await at();

    expect(screen.getByRole('link', { name: 'Créer une classe' }).getAttribute('href')).toBe('/classes/nouvelle');
  });

  it('une non-administratrice n’accède pas à la liste', async () => {
    const étudiante: Me = {
      id: 'u1',
      email: 'awa.diop@esp.sn',
      firstName: 'Awa',
      lastName: 'Diop',
      globalRole: 'USER',
      emailReminders: true,
      emailAnnouncements: true,
      enrollment: null,
      membership: null,
    };
    await at(() => serverError(403, 'FORBIDDEN'), étudiante);

    expect(screen.getByText("Tu n'as pas le droit de faire cette action.")).toBeTruthy();
    expect(screen.queryByText('GIT3')).toBeNull();
  });

  it('un échec du serveur affiche son message et propose « Réessayer »', async () => {
    let failing = true;
    await at((url) => {
      if (url !== LIST) return jsonResponse(200, {});
      return failing ? serverError(500, 'INTERNAL') : jsonResponse(200, CLASSES);
    });

    expect(await screen.findByText('Une erreur est survenue. Réessaie.')).toBeTruthy();
    failing = false;
    screen.getByRole('button', { name: 'Réessayer' }).click();
    expect(await screen.findByText('GIT3')).toBeTruthy();
  });

  it('sans classe, affiche l’état vide', async () => {
    await at((url) => (url === LIST ? jsonResponse(200, []) : jsonResponse(200, {})));

    expect(screen.getByText('Aucune classe pour le moment.')).toBeTruthy();
  });
});
