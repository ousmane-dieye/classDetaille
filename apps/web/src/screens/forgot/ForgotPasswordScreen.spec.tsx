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

function stubApi(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

const anonymous = async (): Promise<Me> => {
  throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

function mount(): void {
  render(
    <MemoryRouter initialEntries={['/mot-de-passe-oublie']}>
      <SessionProvider loadMe={anonymous}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const fillEmail = (value = 'awa@example.com'): void => {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value } });
};

const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer le lien' }));
};

async function completeTurnstile(token = 'jeton-x'): Promise<void> {
  await waitFor(() => expect(widgets.length).toBeGreaterThan(0));
  act(() => widgets.at(-1)?.callback(token));
}

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

describe('mot de passe oublié (§ 3.2)', () => {
  it('propose le champ, la vérification anti-robot et le retour à la connexion', async () => {
    stubApi(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }));
    mount();

    expect(screen.getByRole('heading', { level: 1, name: 'Mot de passe oublié' })).toBeTruthy();
    expect(screen.getAllByLabelText('Email')).toHaveLength(1);
    // Le jeton est obligatoire : le widget est là dès l'ouverture, pas après un échec.
    expect(await screen.findByTestId('cp-turnstile')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Retour à la connexion' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Envoyer le lien' })).toBeTruthy();
  });

  it('répond la confirmation identique et envoie le jeton', async () => {
    let sent: Record<string, unknown> = {};
    stubApi((url, init) => {
      if (url === '/api/auth/forgot-password') {
        sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse(202, { status: 'RESET_REQUESTED' });
      }
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    mount();

    fillEmail();
    await completeTurnstile();
    submit();

    expect(await screen.findByText('Si un compte existe avec cet email, tu reçois un message.')).toBeTruthy();
    expect(screen.getByText(/Le lien est valable 30 minutes/)).toBeTruthy();
    expect(sent.turnstileToken).toBe('jeton-x');
    fireEvent.click(screen.getByRole('link', { name: 'Se connecter' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
  });

  it('503 : message, compte à rebours et email conservé', async () => {
    stubApi((url) =>
      url === '/api/auth/forgot-password'
        ? jsonResponse(503, { error: { code: 'RESET_UNAVAILABLE', retryAfter: 60 }, requestId: 'r' }, { 'retry-after': '60' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mount();

    fillEmail();
    await completeTurnstile();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('La réinitialisation est temporairement indisponible.');
    expect(screen.getByText('01:00')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Envoyer le lien' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('awa@example.com');
  });

  it('429 : message et délai du serveur', async () => {
    stubApi((url) =>
      url === '/api/auth/forgot-password'
        ? jsonResponse(429, { error: { code: 'TOO_MANY_ATTEMPTS', retryAfter: 30 }, requestId: 'r' }, { 'retry-after': '30' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mount();

    fillEmail();
    await completeTurnstile();
    submit();

    expect((await screen.findByRole('alert')).textContent).toContain('Trop de tentatives.');
    expect(screen.getByText('00:30')).toBeTruthy();
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('awa@example.com');
  });

  it('400 TURNSTILE_FAILED : nouveau widget, contenu intact', async () => {
    stubApi((url) =>
      url === '/api/auth/forgot-password'
        ? jsonResponse(400, { error: { code: 'TURNSTILE_FAILED' }, requestId: 'r' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mount();

    fillEmail();
    await completeTurnstile();
    submit();

    expect((await screen.findByRole('alert')).textContent).toBe('La vérification anti-robot a échoué. Réessaie.');
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('awa@example.com');
    // Le jeton périmé n'est jamais réutilisé : un widget de rechange est monté.
    await waitFor(() => expect(widgets.length).toBe(2));
  });

  it('refuse l’envoi sans jeton', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    mount();

    fillEmail();
    submit();

    expect((await screen.findByRole('alert')).textContent).toBe('Vérifie que tu es bien une personne pour continuer.');
    expect(urls).not.toContain('/api/auth/forgot-password');
  });
});
