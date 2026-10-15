import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '../../api/client';
import type { Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function stubApi(handler: (url: string, init: RequestInit) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => handler(url, init)));
}

const anonymous = async (): Promise<Me> => {
  throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

const me: Me = {
  id: 'u1',
  email: 'awa.diop@esp.sn',
  firstName: 'Awa',
  lastName: 'Diop',
  globalRole: 'ADMIN',
  emailReminders: true,
  emailAnnouncements: true,
  enrollment: null,
};

const challengeState = { email: 'awa.diop@esp.sn', expiresInSeconds: 522, resendAfterSeconds: 0 };

/** Observe le chemin courant après une navigation (appelé dans l'arbre rendu). */
function mountAt(path: string, state?: unknown, loadMe: () => Promise<Me> = anonymous): void {
  render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <SessionProvider loadMe={loadMe}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const codeInputs = (): HTMLInputElement[] => screen.getAllByLabelText(/^Chiffre /) as HTMLInputElement[];

/** Première case, accès garanti (`noUncheckedIndexedAccess` oblige). */
const firstCell = (): HTMLInputElement => {
  const found = codeInputs()[0];
  if (!found) throw new Error('case absente');
  return found;
};

const fillCode = (code = '482190'): void => {
  fireEvent.paste(firstCell(), { clipboardData: { getData: () => code } });
};

const validate = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('code à 6 chiffres (P2, M8)', () => {
  it('masque l’email, décompte le code et rappelle la note de l’opérateur', () => {
    stubApi(() => jsonResponse(400, { error: { code: 'CODE_INVALID' }, requestId: 'r' }));
    mountAt('/connexion/code', challengeState);

    expect(screen.getByRole('heading', { level: 1, name: 'Vérifie ton email' })).toBeTruthy();
    expect(screen.getByText(/a•••••@esp\.sn/)).toBeTruthy();
    expect(screen.getByText('Code valable encore')).toBeTruthy();
    expect(screen.getByText('08:42')).toBeTruthy();
    expect(screen.getByText(/Contacte un opérateur de la plateforme/)).toBeTruthy();
    expect(screen.getByText(/Tu peux coller le code reçu\./)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Valider' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('colle le code, valide et ouvre la session', async () => {
    let sent: Record<string, unknown> = {};
    stubApi((url, init) => {
      sent = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      return url === '/api/auth/verify-code' ? jsonResponse(200, me) : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    mountAt('/connexion/code', challengeState);

    fillCode('482190');
    expect((screen.getByRole('button', { name: 'Valider' }) as HTMLButtonElement).disabled).toBe(false);
    validate();

    expect(sent.code).toBe('482190');
    expect(await screen.findByRole('heading', { level: 1, name: 'Aucune demande en attente' })).toBeTruthy();
  });

  it('code incorrect : essais restants, cases conservées, focus au premier champ', async () => {
    stubApi((url) =>
      url === '/api/auth/verify-code'
        ? jsonResponse(400, { error: { code: 'CODE_INVALID', attemptsLeft: 4 }, requestId: 'r' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mountAt('/connexion/code', challengeState);

    fillCode('482190');
    validate();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Code incorrect. Il te reste 4 essais.');
    expect(codeInputs().map((cell) => cell.value).join('')).toBe('482190');
    await waitFor(() => expect(document.activeElement).toBe(firstCell()));
  });

  it('code expiré : renvoie vers la connexion', async () => {
    stubApi((url) =>
      url === '/api/auth/verify-code'
        ? jsonResponse(400, { error: { code: 'CHALLENGE_EXPIRED' }, requestId: 'r' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mountAt('/connexion/code', challengeState);

    fillCode();
    validate();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Ce code n’est plus valable. Connecte-toi à nouveau pour recevoir un code.',
    );
    fireEvent.click(screen.getByRole('link', { name: 'Retour à la connexion' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
  });

  it('trop de renvois : le décompte reprend sur le délai du serveur', async () => {
    stubApi((url) =>
      url === '/api/auth/resend-code'
        ? jsonResponse(429, { error: { code: 'TOO_MANY_CODE_REQUESTS', retryAfter: 45 }, requestId: 'r' }, { 'retry-after': '45' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mountAt('/connexion/code', challengeState);

    fireEvent.click(screen.getByRole('button', { name: 'Renvoyer' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Trop de demandes de code.');
    expect(screen.getByText('00:45')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Renvoyer' })).toBeNull();
  });

  it('un nouveau code vide les cases et redémarre le délai de renvoi', async () => {
    stubApi((url) =>
      url === '/api/auth/resend-code'
        ? jsonResponse(202, { status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: 600, resendAfterSeconds: 60 })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    mountAt('/connexion/code', { ...challengeState, resendAfterSeconds: 0 });

    fillCode('111111');
    fireEvent.click(screen.getByRole('button', { name: 'Renvoyer' }));

    await waitFor(() => expect(codeInputs().map((c) => c.value).join('')).toBe(''));
    expect(screen.queryByRole('button', { name: 'Renvoyer' })).toBeNull();
    expect(screen.getByText('01:00')).toBeTruthy();
    expect(screen.getByText('10:00')).toBeTruthy();
  });

  it('sans défi en cours, renvoie vers la connexion', () => {
    stubApi(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }));
    mountAt('/connexion/code');
    expect(screen.getByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
  });
});
