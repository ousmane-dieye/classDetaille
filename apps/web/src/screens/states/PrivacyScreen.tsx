import type { ReactElement } from 'react';

/**
 * UX § 1.1 : « Confidentialité » fait partie de l'espace non connecté.
 * Le texte définitif vient du responsable (à fournir) : la page n'affiche que ce qui est
 * déjà acté par la spécification, sans rien inventer.
 */
export function PrivacyScreen(): ReactElement {
  return (
    <div className="cp-state">
      <h1>Confidentialité</h1>
      <p>Cette page présente ce que ClassePulse conserve et comment le récupérer ou le supprimer.</p>
      <p>Le texte détaillé sera publié avec l&#39;accord du responsable de la plateforme.</p>
      <p>
        <a href="/connexion">Retourner à la connexion</a>
      </p>
    </div>
  );
}
