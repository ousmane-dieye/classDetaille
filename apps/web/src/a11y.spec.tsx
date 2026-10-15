import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from './api/client';
import type { Enrollment, Me, Session } from './api/types';
import { SkipLink } from './components/SkipLink';
import { AppRoutes } from './routes';
import { SessionProvider } from './session/session-context';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CLASS = { id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' };

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

const pendingEnrollment: Enrollment = {
  id: 'e1',
  status: 'PENDING',
  class: CLASS,
  createdAt: '2026-10-14T10:00:00.000Z',
  decidedAt: null,
  decisionNote: null,
  retryAfter: null,
};

const mePending: Me = { ...me, enrollment: pendingEnrollment };

const session: Session = {
  id: 's1',
  createdAt: '2026-10-12T10:00:00.000Z',
  lastSeenAt: '2026-10-15T09:41:00.000Z',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  current: true,
};

const anonymous = async (): Promise<Me> => {
  throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

beforeEach(() => {
  document.documentElement.lang = 'fr';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/classes/active') return jsonResponse(200, [CLASS]);
      if (url === '/api/me/sessions') return jsonResponse(200, [session]);
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    }),
  );
  vi.stubGlobal('turnstile', { render: vi.fn(), reset: vi.fn(), remove: vi.fn() });
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
});

function mountAt(path: string, options: { loadMe?: () => Promise<Me>; state?: unknown } = {}): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={[{ pathname: path, ...(options.state ? { state: options.state } : {}) }]}>
      <SessionProvider loadMe={options.loadMe ?? anonymous}>
        <SkipLink />
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
  return container;
}

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    // jsdom ne rend pas : le contraste des couleurs n'est pas mesurable ici (tokens.spec le couvre).
    rules: { 'color-contrast': { enabled: false } },
  });
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = serious.map((v) => `${v.id} (${v.impact}) : ${v.nodes.map((n) => n.html).join(' ;; ')}`);
  expect(summary).toEqual([]);
}

type ScreenCase = { name: string; path: string; loadMe: () => Promise<Me>; state?: unknown };

const SCREENS: ScreenCase[] = [
  { name: 'inscription', path: '/inscription', loadMe: anonymous },
  { name: 'connexion', path: '/connexion', loadMe: anonymous },
  {
    name: 'code administrateur',
    path: '/connexion/code',
    loadMe: anonymous,
    state: { email: 'op@esp.sn', expiresInSeconds: 600, resendAfterSeconds: 30 },
  },
  { name: 'mot de passe oublié', path: '/mot-de-passe-oublie', loadMe: anonymous },
  { name: 'réinitialisation sans jeton', path: '/reinitialiser-mot-de-passe', loadMe: anonymous },
  { name: 'état : demande refusée', path: '/etat/demande-refusee', loadMe: anonymous },
  { name: 'état : demande envoyée', path: '/etat/demande-envoyee', loadMe: async () => mePending },
  { name: 'état : introuvable', path: '/quelque-chose', loadMe: anonymous },
  { name: 'confidentialité', path: '/confidentialite', loadMe: anonymous },
  { name: 'profil', path: '/profil', loadMe: async () => me },
  { name: 'sessions actives', path: '/profil/sessions', loadMe: async () => me },
];

describe('accessibilité (§ 5, axe-core)', () => {
  it.each(SCREENS)('$name : aucune violation sérieuse, en clair comme en sombre', async ({ path, loadMe, state }) => {
    for (const theme of ['light', 'dark']) {
      document.documentElement.setAttribute('data-theme', theme);
      const container = mountAt(path, { loadMe, ...(state ? { state } : {}) });
      await screen.findByRole('heading', { level: 1 });
      await expectNoSeriousViolations(container);
      cleanup();
    }
  });

  it('le lien d’évitement vise le repère principal, recevable au focus (UX § 5.1)', () => {
    const container = mountAt('/connexion');
    const link = screen.getByRole('link', { name: 'Aller au contenu' });
    expect(link.getAttribute('href')).toBe('#contenu');
    const main = container.querySelector('main');
    expect(main?.getAttribute('id')).toBe('contenu');
    expect(main?.getAttribute('tabindex')).toBe('-1');
  });

  it('les six cases du code suivent l’ordre du document et se parcourent aux flèches', async () => {
    mountAt('/connexion/code', {
      loadMe: anonymous,
      state: { email: 'op@esp.sn', expiresInSeconds: 600, resendAfterSeconds: 30 },
    });
    await screen.findByRole('heading', { level: 1, name: 'Vérifie ton email' });

    const cells = screen.getAllByRole('textbox', { name: /^Chiffre / });
    expect(cells).toHaveLength(6);
    for (const [index, cell] of cells.entries()) {
      expect(cell.getAttribute('aria-label')).toBe(`Chiffre ${index + 1}`);
      // Aucun tabindex positif : l'ordre de tabulation est celui du document.
      expect(cell.getAttribute('tabindex')).toBeNull();
    }

    const first = cells[0];
    if (!first) throw new Error('première case absente');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells[1]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells[2]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cells[1]);
  });

  it('un champ en erreur annonce aria-invalid et relie son message (UX § 3.1)', async () => {
    mountAt('/inscription');
    const confirm = await screen.findByLabelText('Confirme ton mot de passe');
    fireEvent.change(confirm, { target: { value: 'autre phrase de passe' } });
    fireEvent.blur(confirm);

    expect(await screen.findByText('Les deux mots de passe ne correspondent pas.')).toBeTruthy();
    expect(confirm.getAttribute('aria-invalid')).toBe('true');
    const describedBy = confirm.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    const message = describedBy
      .split(' ')
      .map((id) => document.getElementById(id))
      .find((element) => element !== null);
    expect(message?.textContent).toBe('Les deux mots de passe ne correspondent pas.');
  });
});
