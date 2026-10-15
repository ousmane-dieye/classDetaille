import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Enrollment, Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url === '/api/auth/logout' ? jsonResponse(204, null) : jsonResponse(200, {}))),
  );
}

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
  };
}

function at(path: string, me: Me): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider loadMe={async () => me}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
});
