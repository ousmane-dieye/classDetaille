import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '../../api/client';
import type { Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

type WidgetOptions = { sitekey: string; callback(token: string): void; 'expired-callback'(): void; 'error-callback'(): void };

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let widgets: WidgetOptions[] = [];

function stubApi(handler: (url: string, init: RequestInit) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => handler(url, init)),
  );
}

const anonymous = async (): Promise<Me> => {
  throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

function meWithEnrollment(status: 'PENDING' | 'ACCEPTED' | 'REFUSED'): Me {
  return {
    id: 'u1',
    email: 'awa.diop@esp.sn',
    firstName: 'Awa',
    lastName: 'Diop',
    globalRole: 'USER',
    emailReminders: true,
    emailAnnouncements: true,
    enrollment: {
      id: 'e1',
      status,
      class: { id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' },
      createdAt: new Date(2026, 9, 14, 9, 41).toISOString(),
      decidedAt: null,
      decisionNote: null,
      retryAfter: null,
    },
  };
}

function mountAt(path: string, loadMe: () => Promise<Me> = anonymous): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider loadMe={loadMe}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

function fillCredentials(): void {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'awa@example.com' } });
  fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'une phrase de passe' } });
}

const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
};

beforeEach(() => {
  vi.stubEnv('VITE_TURNSTILE_SITEKEY', 'cle-de-test');
  widgets = [];
  vi.stubGlobal('turnstile', {
    render: (_container: HTMLElement, options: WidgetOptions) => {
      widgets.push(options);
      return `widget-${widgets.length}`;
    },
    reset: vi.fn(),
    remove: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('connexion (P2, M8)', () => {
  it('propose les champs, le mot de passe oublié et la création de compte', async () => {
    stubApi(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }));
    mountAt('/connexion');

    expect(screen.getByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
    expect(screen.getByText(/Avec l'email utilisé à l'inscription\./)).toBeTruthy();
    expect(screen.getByText('Content de te revoir.')).toBeTruthy();
    expect(screen.getAllByLabelText('Email')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Afficher' })).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Mot de passe oublié ?' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Mot de passe oublié' })).toBeTruthy();
  });

  it('renvoie vers l’inscription depuis « Pas encore de compte ? »', async () => {
    stubApi(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }));
    mountAt('/connexion');
    fireEvent.click(screen.getByRole('link', { name: 'Créer un compte' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Créer ton compte' })).toBeTruthy();
  });

  it.each(['INVALID_CREDENTIALS', 'TURNSTILE_FAILED', 'TURNSTILE_REQUIRED'])(
    '%s affiche le message identique de la spécification',
    async (code) => {
      stubApi((url) =>
        url === '/api/auth/login'
          ? jsonResponse(401, { error: { code, turnstileRequired: false }, requestId: 'r' })
          : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
      );
      mountAt('/connexion');
      fillCredentials();
      submit();

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('Email ou mot de passe incorrect.');
      expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('awa@example.com');
    },
  );

  it('après plusieurs échecs, la vérification anti-robot apparaît puis est envoyée', async () => {
    let sent: Record<string, unknown> = {};
    stubApi((url, init) => {
      if (url !== '/api/auth/login') return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
      sent = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      return sent.turnstileToken === 'jeton-1'
        ? jsonResponse(200, meWithEnrollment('PENDING'))
        : jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', turnstileRequired: true }, requestId: 'r' });
    });
    mountAt('/connexion');

    fillCredentials();
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe('Email ou mot de passe incorrect.');
    await waitFor(() => expect(widgets).toHaveLength(1));

    await waitFor(() => expect(widgets.at(0)).toBeDefined());
    act(() => widgets.at(0)?.callback('jeton-1'));
    submit();

    expect(await screen.findByRole('heading', { level: 1, name: 'Demande envoyée' })).toBeTruthy();
    expect(sent.turnstileToken).toBe('jeton-1');
  });

  it('signale un compte suspendu après un mot de passe correct', async () => {
    stubApi((url) =>
      url === '/api/auth/login'
        ? jsonResponse(403, { error: { code: 'ACCOUNT_SUSPENDED' }, requestId: 'r' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mountAt('/connexion');
    fillCredentials();
    submit();

    expect((await screen.findByRole('alert')).textContent).toBe('Ton compte est suspendu. Contacte la plateforme.');
  });

  it('trop de tentatives : compte à rebours et bouton inutilisable', async () => {
    stubApi((url) =>
      url === '/api/auth/login'
        ? jsonResponse(429, { error: { code: 'TOO_MANY_ATTEMPTS', retryAfter: 30 }, requestId: 'r' }, { 'retry-after': '30' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mountAt('/connexion');
    fillCredentials();
    submit();

    expect((await screen.findByRole('alert')).textContent).toContain('Trop de tentatives.');
    expect(screen.getByText('00:30')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Se connecter' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('un administrateur rejoint l’écran du code', async () => {
    stubApi((url) =>
      url === '/api/auth/login'
        ? jsonResponse(202, { status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: 600, resendAfterSeconds: 60 })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mountAt('/connexion');
    fillCredentials();
    submit();

    expect(await screen.findByRole('heading', { level: 1, name: 'Vérifie ton email' })).toBeTruthy();
  });

  it('un compte déjà connecté rejoint directement son état', async () => {
    stubApi(() => jsonResponse(200, {}));
    mountAt('/connexion', async () => meWithEnrollment('PENDING'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Demande envoyée' })).toBeTruthy();
  });
});
