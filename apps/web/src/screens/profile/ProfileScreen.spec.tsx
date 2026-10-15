import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '../../api/client';
import type { Me } from '../../api/types';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/session-context';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

const me: Me = {
  id: 'u1',
  email: 'awa.diop@esp.sn',
  firstName: 'Awa',
  lastName: 'Diop',
  globalRole: 'USER',
  emailReminders: true,
  emailAnnouncements: false,
  enrollment: null,
};

const unauthenticated = async (): Promise<Me> => {
  throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
};

/** Monte l'écran et attend le rendu du profil (le profil est chargé par la session). */
async function mountAt(profile: Me = me, loadMe: () => Promise<Me> = async () => profile): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/profil']}>
      <SessionProvider loadMe={loadMe}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Profil' });
}

const openPassword = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Changer mon mot de passe' }));
};

function fillPassword(newPassword: string, current = 'ancien mot de passe actuel'): void {
  fireEvent.change(screen.getByLabelText('Mot de passe actuel'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('Nouveau mot de passe'), { target: { value: newPassword } });
  fireEvent.change(screen.getByLabelText('Confirme ton nouveau mot de passe'), { target: { value: newPassword } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('profil (P10, M14)', () => {
  it('affiche le nom, l’email en lecture seule et le lien vers les sessions', async () => {
    stubApi(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }));
    await mountAt();

    expect(screen.getByRole('heading', { level: 1, name: 'Profil' })).toBeTruthy();
    expect((screen.getByLabelText('Prénom') as HTMLInputElement).value).toBe('Awa');
    // « Nom » nomme aussi la section (aria-labelledby) : on vise le champ.
    expect((screen.getByLabelText('Nom', { selector: 'input' }) as HTMLInputElement).value).toBe('Diop');
    expect((screen.getByLabelText('Email') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByLabelText('Rappels de devoirs')).toBeTruthy();
    expect(screen.getByLabelText('Annonces par email')).toBeTruthy();
    expect(screen.getByText(/Les notifications dans l'application restent toujours actives\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sessions actives' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Changer mon mot de passe' })).toBeTruthy();
  });

  it('enregistre le nom et confirme sans quitter l’écran', async () => {
    let sent: Record<string, unknown> = {};
    stubApi((url, init) => {
      if (url === '/api/me/profile') {
        sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse(200, { ...me, firstName: 'Awaïcha' });
      }
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    await mountAt();

    fireEvent.change(screen.getByLabelText('Prénom'), { target: { value: 'Awaïcha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByText('Profil enregistré.')).toBeTruthy();
    expect(sent).toEqual({ firstName: 'Awaïcha', lastName: 'Diop' });
  });

  it('erreur serveur : message affiché et contenu conservé', async () => {
    stubApi((url) =>
      url === '/api/me/profile'
        ? jsonResponse(500, { error: { code: 'INTERNAL' }, requestId: 'r' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    await mountAt();

    fireEvent.change(screen.getByLabelText('Prénom'), { target: { value: 'Awaïcha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Une erreur est survenue. Réessaie.');
    expect((screen.getByLabelText('Prénom') as HTMLInputElement).value).toBe('Awaïcha');
  });

  it('mot de passe actuel incorrect : message sous le champ, contenu conservé', async () => {
    stubApi((url) =>
      url === '/api/me/password'
        ? jsonResponse(400, { error: { code: 'CURRENT_PASSWORD_INVALID' }, requestId: 'r' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    await mountAt();

    openPassword();
    fillPassword('une phrase de passe neuve');
    fireEvent.click(screen.getByRole('button', { name: 'Mettre à jour mon mot de passe' }));

    expect(await screen.findByText('Ce mot de passe actuel est incorrect.')).toBeTruthy();
    expect((screen.getByLabelText('Nouveau mot de passe') as HTMLInputElement).value).toBe('une phrase de passe neuve');
    expect((screen.getByLabelText('Mot de passe actuel') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
  });

  it('403 REAUTH_REQUIRED : la ressaisie est expliquée', async () => {
    stubApi((url) =>
      url === '/api/me/password'
        ? jsonResponse(403, { error: { code: 'REAUTH_REQUIRED' }, requestId: 'r' })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }),
    );
    await mountAt();

    openPassword();
    fillPassword('une phrase de passe neuve');
    fireEvent.click(screen.getByRole('button', { name: 'Mettre à jour mon mot de passe' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Confirme ton mot de passe pour continuer.');
    expect((screen.getByLabelText('Nouveau mot de passe') as HTMLInputElement).value).toBe('une phrase de passe neuve');
  });

  it('administrateur : politique de 16 caractères avant tout envoi', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    await mountAt({ ...me, globalRole: 'ADMIN' });

    openPassword();
    expect(screen.getByText(/caractères minimum/)).toBeTruthy();
    fillPassword('123456789012345'); // 15 caractères
    fireEvent.click(screen.getByRole('button', { name: 'Mettre à jour mon mot de passe' }));

    expect(screen.getByText('Ce mot de passe est trop court : 16 caractères minimum.')).toBeTruthy();
    expect(urls).not.toContain('/api/me/password');
  });

  it('préférences d’email enregistrées au choix', async () => {
    let sent: Record<string, unknown> = {};
    stubApi((url, init) => {
      if (url === '/api/me/email-preferences') {
        sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse(200, { ...me, emailAnnouncements: true });
      }
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' });
    });
    await mountAt();

    fireEvent.click(screen.getByLabelText('Annonces par email'));

    expect(await screen.findByText('Préférences enregistrées.')).toBeTruthy();
    expect(sent).toEqual({ emailReminders: true, emailAnnouncements: true });
  });

  it('thème : système, clair ou sombre, mémorisé dans cp.theme', async () => {
    stubApi(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }));
    await mountAt();

    fireEvent.click(screen.getByLabelText('Sombre'));
    expect(localStorage.getItem('cp.theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    fireEvent.click(screen.getByLabelText('Système'));
    expect(localStorage.getItem('cp.theme')).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('sans session, renvoie vers la connexion', async () => {
    stubApi(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' }, requestId: 'r' }));
    // `mountAt` attend le titre « Profil » : ici la session échoue, donc on rend sans attente.
    render(
      <MemoryRouter initialEntries={['/profil']}>
        <SessionProvider loadMe={unauthenticated}>
          <AppRoutes />
        </SessionProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
  });
});
