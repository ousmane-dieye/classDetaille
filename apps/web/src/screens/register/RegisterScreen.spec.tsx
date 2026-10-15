import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '../../api/client';
import type { Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

type WidgetOptions = { sitekey: string; callback(token: string): void; 'expired-callback'(): void; 'error-callback'(): void };

const SITE_KEY = 'cle-de-test';
let widgets: WidgetOptions[] = [];

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const anonymous = async (): Promise<Me> => {
  throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

function stubApi(handlers: Record<string, (init: RequestInit) => Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const handler = handlers[url];
      if (!handler) return jsonResponse(500, { error: { code: 'INTERNAL' }, requestId: 'inattendu' });
      return handler(init);
    }),
  );
}

function mountAtInscription(): void {
  render(
    <MemoryRouter initialEntries={['/inscription']}>
      <SessionProvider loadMe={anonymous}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function fillForm(overrides: Partial<Record<string, string>> = {}): Promise<void> {
  const values: Record<string, string> = {
    'Prénom': 'Awa',
    'Nom': 'Diop',
    'Email': 'awa@example.com',
    'Mot de passe': 'une phrase de passe assez longue',
    'Confirme ton mot de passe': 'une phrase de passe assez longue',
    ...overrides,
  };
  for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  // La liste des classes est chargée par le serveur : on attend le champ.
  fireEvent.change(await screen.findByLabelText('Ta classe'), { target: { value: 'c1' } });
}

const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer ma demande' }));
};
/** Le widget est monté par un micro-tâche : on attend sa présence avant d'émettre le jeton. */
async function completeTurnstile(token = 'jeton-x'): Promise<void> {
  await waitFor(() => expect(widgets.length).toBeGreaterThan(0));
  const widget = widgets.at(-1);
  // Le jeton arrive hors d'un événement React : `act` applique la mise à jour avant la suite.
  act(() => widget?.callback(token));
}

beforeEach(() => {
  vi.stubEnv('VITE_TURNSTILE_SITEKEY', SITE_KEY);
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

describe('inscription (P1, M7)', () => {
  it('demande l’essentiel, une seule fois l’email, avec l’aide et la longueur minimale', async () => {
    stubApi({
      '/api/me': () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
      '/api/classes/active': () => jsonResponse(200, [{ id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' }]),
    });
    mountAtInscription();

    expect(screen.getByRole('heading', { level: 1, name: 'Créer ton compte' })).toBeTruthy();
    expect(screen.getAllByLabelText('Email')).toHaveLength(1);
    expect(screen.getByText(/Tes rappels et la récupération de ton compte arriveront à cette adresse : vérifie-la bien\./)).toBeTruthy();
    expect(screen.getByText(/caractères minimum/)).toBeTruthy();
    const option = await screen.findByRole('option', { name: /GIT3 · 2026-2027/ });
    expect(option).toBeTruthy();
    expect(screen.getByTestId('cp-turnstile').getAttribute('data-testid')).toBe('cp-turnstile');
  });

  it('signale les mots de passe différents en quittant le champ, sans effacer le reste', async () => {
    stubApi({ '/api/me': () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }), '/api/classes/active': () => jsonResponse(200, []) });
    mountAtInscription();
    await fillForm({ 'Confirme ton mot de passe': 'une autre phrase' });
    fireEvent.blur(screen.getByLabelText('Confirme ton mot de passe'));

    expect(screen.getByRole('alert').textContent).toContain('Les deux mots de passe ne correspondent pas.');
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('awa@example.com');
  });

  it('envoie la demande et affiche la confirmation', async () => {
    let sent: Record<string, unknown> = {};
    const me: Me = {
      id: 'u1',
      email: 'awa@example.com',
      firstName: 'Awa',
      lastName: 'Diop',
      globalRole: 'USER',
      emailReminders: true,
      emailAnnouncements: true,
      enrollment: {
        id: 'e1',
        status: 'PENDING',
        class: { id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' },
        createdAt: new Date(2026, 9, 14, 9, 41).toISOString(),
        decidedAt: null,
        decisionNote: null,
        retryAfter: null,
      },
    };
    stubApi({
      '/api/me': () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
      '/api/classes/active': () => jsonResponse(200, [{ id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' }]),
      '/api/auth/register': (init) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse(201, me);
      },
    });
    mountAtInscription();
    await fillForm();
    await completeTurnstile();
    submit();

    expect(await screen.findByRole('heading', { level: 1, name: 'Demande envoyée' })).toBeTruthy();
    expect(sent).toMatchObject({
      firstName: 'Awa',
      lastName: 'Diop',
      email: 'awa@example.com',
      classId: 'c1',
      turnstileToken: 'jeton-x',
    });
  });

  it('un compte existant est signalé, le contenu saisi est conservé', async () => {
    stubApi({
      '/api/me': () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
      '/api/classes/active': () => jsonResponse(200, [{ id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' }]),
      '/api/auth/register': () => jsonResponse(409, { error: { code: 'EMAIL_TAKEN' }, requestId: 'r' }),
    });
    mountAtInscription();
    await fillForm();
    await completeTurnstile();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Un compte existe déjà avec cet email. Essaie de te connecter.');
    expect(screen.getByRole('link', { name: 'Se connecter' })).toBeTruthy();
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('awa@example.com');
  });

  it('inscription temporairement indisponible : compte à rebours et bouton inutilisable', async () => {
    stubApi({
      '/api/me': () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
      '/api/classes/active': () => jsonResponse(200, [{ id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' }]),
      '/api/auth/register': () => jsonResponse(503, { error: { code: 'SIGNUP_UNAVAILABLE' }, requestId: 'r' }, { 'retry-after': '30' }),
    });
    mountAtInscription();
    await fillForm();
    await completeTurnstile();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("L'inscription est temporairement indisponible.");
    expect(screen.getByText('00:30')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Envoyer ma demande' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('trop de requêtes : le délai est respecté', async () => {
    stubApi({
      '/api/me': () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
      '/api/classes/active': () => jsonResponse(200, [{ id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' }]),
      '/api/auth/register': () => jsonResponse(429, { error: { code: 'TOO_MANY_REQUESTS' }, requestId: 'r' }, { 'retry-after': '12' }),
    });
    mountAtInscription();
    await fillForm();
    await completeTurnstile();
    submit();

    expect((await screen.findByRole('alert')).textContent).toContain('Trop de requêtes.');
    expect(screen.getByText('00:12')).toBeTruthy();
  });

  it('un échec anti-robot propose une nouvelle vérification', async () => {
    stubApi({
      '/api/me': () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
      '/api/classes/active': () => jsonResponse(200, [{ id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' }]),
      '/api/auth/register': () => jsonResponse(400, { error: { code: 'TURNSTILE_FAILED' }, requestId: 'r' }),
    });
    mountAtInscription();
    await fillForm();
    await completeTurnstile();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('anti-robot');
    await waitFor(() => expect(widgets.length).toBe(2));
    // Le jeton périmé n'est jamais réutilisé : une nouvelle vérification est nécessaire.
    await completeTurnstile('jeton-y');
    await waitFor(() => expect(widgets).toHaveLength(2));
  });

  it('hors connexion : la demande est impossible, et la raison est dite (M14)', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
      }),
    );
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    try {
      mountAtInscription();

      expect(screen.getByText(/Hors connexion, tu peux consulter mais pas modifier\./)).toBeTruthy();
      const button = screen.getByRole('button', { name: 'Envoyer ma demande' }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
      expect(urls.filter((u) => u === '/api/auth/register')).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(navigator, 'onLine');
    }
  });
});
