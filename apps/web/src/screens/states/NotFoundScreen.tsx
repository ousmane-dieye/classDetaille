import type { ReactElement } from 'react';

/** UX § 3.2 « Introuvable » : même texte pour un élément d'une autre classe. */
export function NotFoundScreen(): ReactElement {
  return (
    <div className="cp-state">
      <h1>Cet élément n&#39;existe pas ou n&#39;est plus disponible</h1>
      <p>Reviens à l&#39;accueil pour retrouver ce qui est encore accessible.</p>
      <p>
        <a href="/connexion">Retourner à la connexion</a>
      </p>
    </div>
  );
}
