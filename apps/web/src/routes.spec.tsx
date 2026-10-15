import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from './api/client';
import type { Me } from './api/types';
import { SessionProvider } from './session/session-context';
import { AppRoutes } from './routes';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

/** @param auth les écrans de profil exigent une session ; les autres se rendent anonymes. */
function at(path: string, auth = false): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider
        loadMe={async () => {
          if (auth) return me;
          throw new ApiProblem({ status: 401, code: 'UNAUTHENTICATED', extra: {}, requestId: 'r', retryAfterSeconds: null });
        }}
      >
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('routes', () => {
  it.each([
    ['/inscription', 'Créer ton compte', false],
    ['/connexion', 'Se connecter', false],
    ['/mot-de-passe-oublie', 'Mot de passe oublié', false],
    // L'email du lot 1b pointe vers `/reinitialiser-mot-de-passe#token=…` : le web suit le contrat.
    ['/reinitialiser-mot-de-passe', 'Choisis un nouveau mot de passe', false],
    ['/profil', 'Profil', true],
    ['/profil/sessions', 'Sessions actives', true],
    ['/confidentialite', 'Confidentialité', false],
  ])('%s affiche « %s »', async (path, heading, auth) => {
    at(path, auth);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
  });

  it('la racine redirige vers la connexion', () => {
    at('/');
    expect(screen.getByRole('heading', { level: 1, name: 'Se connecter' })).toBeTruthy();
  });

  it('une adresse inconnue affiche l’écran « introuvable »', () => {
    at('/quelque-chose');
    expect(screen.getByRole('heading', { level: 1, name: "Cet élément n'existe pas ou n'est plus disponible" })).toBeTruthy();
  });

  it('chaque écran est rendu dans le repère principal', () => {
    at('/connexion');
    const main = screen.getByRole('main');
    expect(main.getAttribute('id')).toBe('contenu');
    expect(main.contains(screen.getByRole('heading', { level: 1, name: 'Se connecter' }))).toBe(true);
  });
});
