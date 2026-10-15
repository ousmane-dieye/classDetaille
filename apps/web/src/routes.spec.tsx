import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from './session/session-context';
import { AppRoutes } from './routes';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function at(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider loadMe={async () => Promise.reject(new Error('hors session'))}>
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('routes', () => {
  it.each([
    ['/inscription', 'Créer ton compte'],
    ['/connexion', 'Se connecter'],
    ['/connexion/code', 'Vérifie ton email'],
    ['/mot-de-passe-oublie', 'Mot de passe oublié'],
    ['/reinitialisation', 'Choisis un nouveau mot de passe'],
    ['/profil', 'Profil'],
    ['/profil/sessions', 'Sessions actives'],
    ['/confidentialite', 'Confidentialité'],
    ['/etat/demande-envoyee', 'Demande envoyée'],
    ['/etat/demande-refusee', 'Demande refusée'],
  ])('%s affiche « %s »', (path, heading) => {
    at(path);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeTruthy();
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
