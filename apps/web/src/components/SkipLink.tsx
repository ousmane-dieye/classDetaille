import type { ReactElement } from 'react';

/** Lien d'évitement : premier élément focalisable de la page (UX § 5.1). */
export function SkipLink(): ReactElement {
  return (
    <a className="cp-skiplink" href="#contenu">
      Aller au contenu
    </a>
  );
}
