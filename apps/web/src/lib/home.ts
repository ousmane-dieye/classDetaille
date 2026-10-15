import type { Me } from '../api/types';

/**
 * Écran d'accueil selon l'état du compte (UX § 1.1 « Espaces selon le statut ») :
 * en attente → l'écran d'état, refusé → l'écran de refus, accepté → le profil (les écrans de la
 * classe arrivent avec les lots suivants). Un anonyme n'a pas d'accueil : la connexion.
 */
export function homePathFor(me: Me | null): string {
  switch (me?.enrollment?.status) {
    case 'REFUSED':
      return '/etat/demande-refusee';
    case 'ACCEPTED':
      return '/profil';
    default:
      return '/etat/demande-envoyee';
  }
}
