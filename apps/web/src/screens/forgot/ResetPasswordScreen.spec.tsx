import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '../../api/client';
import type { Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const TOKEN = 'A'.repeat(43);

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  // `Response` refuse tout corps sur 204/304 : on renvoie un corps vide.
  status === 204 || status === 304
    ? new Response(null, { status, headers })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function stubApi(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

const anonymous = async (): Promise<Me> => {
  throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

/** Observe le fragment de l'adresse (où le serveur place le jeton, R8 du lot 1b). */
let currentHash = '#token=en-attente';
function Spy(): null {
  currentHash = useLocation().hash;
  return null;
}

function mountAt(hash = `#token=${TOKEN}`): void {
  render(
    <MemoryRouter initialEntries={[`/reinitialiser-mot-de-passe${hash}`]}>
      <SessionProvider loadMe={anonymous}>
        <Spy />
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const NEW_PASSWORD = 'une phrase de passe neuve';

function fillPassword(overrides: Partial<Record<string, string>> = {}): void {
  const values: Record<string, string> = {
    'Nouveau mot de passe': NEW_PASSWORD,
    'Confirme ton nouveau mot de passe': NEW_PASSWORD,
    ...overrides,
  };
  for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Choisir ce mot de passe' }));
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  currentHash = '#token=en-attente';
});

describe('réinitialisation du mot de passe (§ 3.2)', () => {
  it('sans jeton dans le lien, annonce un lien périmé et propose une nouvelle demande', () => {
    stubApi(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }));
    mountAt('');

    expect(screen.getByText(/Ce lien n’est plus valable/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Choisis un nouveau mot de passe' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Demander un nouveau lien' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Mot de passe oublié' })).toBeTruthy();
  });

  it('demande le mot de passe en double, avec la politique de 15 caractères', () => {
    stubApi(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }));
    mountAt();

    expect(screen.getByRole('heading', { level: 1, name: 'Choisis un nouveau mot de passe' })).toBeTruthy();
    expect(screen.getByLabelText('Nouveau mot de passe')).toBeTruthy();
    expect(screen.getByLabelText('Confirme ton nouveau mot de passe')).toBeTruthy();
    expect(screen.getByText(/caractères minimum/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Afficher' })).toHaveLength(2);
  });

  it('signale les mots de passe différents en quittant le second champ, sans rien envoyer', () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    mountAt();

    fillPassword({ 'Confirme ton nouveau mot de passe': 'une autre phrase' });
    fireEvent.blur(screen.getByLabelText('Confirme ton nouveau mot de passe'));

    expect(screen.getByText('Les deux mots de passe ne correspondent pas.')).toBeTruthy();
    submit();
    expect(urls).not.toContain('/api/auth/reset-password');
  });

  it('refuse un mot de passe trop court avant tout envoi', () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    mountAt();

    fillPassword({ 'Nouveau mot de passe': 'court', 'Confirme ton nouveau mot de passe': 'court' });
    submit();

    expect(screen.getByText('Ce mot de passe est trop court : 15 caractères minimum.')).toBeTruthy();
    expect(urls).not.toContain('/api/auth/reset-password');
  });

  it('enregistre le nouveau mot de passe et renvoie vers la connexion', async () => {
    let sent: Record<string, unknown> = {};
    stubApi((url, init) => {
      if (url === '/api/auth/reset-password') {
        sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse(204, null);
      }
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    mountAt();

    fillPassword();
    submit();

    expect(sent).toEqual({ token: TOKEN, newPassword: NEW_PASSWORD });
    expect(await screen.findByRole('heading', { level: 1, name: 'Mot de passe modifié' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Se connecter' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
  });

  it('jeton refusé : message et lien vers une nouvelle demande, contenu conservé', async () => {
    stubApi((url) =>
      url === '/api/auth/reset-password'
        ? jsonResponse(400, { error: { code: 'RESET_TOKEN_INVALID' }, requestId: 'r' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mountAt();

    fillPassword();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Ce lien n’est plus valable. Demande un nouveau mot de passe oublié.');
    expect((screen.getByLabelText('Nouveau mot de passe') as HTMLInputElement).value).toBe(NEW_PASSWORD);
    expect(screen.getByRole('link', { name: 'Demander un nouveau lien' })).toBeTruthy();
  });

  it('503 : message du serveur sans rien effacer', async () => {
    stubApi((url) =>
      url === '/api/auth/reset-password'
        ? jsonResponse(503, { error: { code: 'RESET_UNAVAILABLE', retryAfter: 60 }, requestId: 'r' }, { 'retry-after': '60' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mountAt();

    fillPassword();
    submit();

    expect((await screen.findByRole('alert')).textContent).toContain('La réinitialisation est temporairement indisponible.');
    expect((screen.getByLabelText('Nouveau mot de passe') as HTMLInputElement).value).toBe(NEW_PASSWORD);
    expect(screen.getByText('01:00')).toBeTruthy();
  });

  it('retire le jeton de l’adresse après lecture', async () => {
    stubApi(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }));
    // Le jeton n'est jamais dans la query string (fragment, R8 du lot 1b) : une fois lu,
    // l'écran le retire de l'adresse affichée pour qu'il ne survive ni à l'historique ni au partage.
    mountAt();
    await waitFor(() => expect(currentHash).toBe(''));
  });
});
