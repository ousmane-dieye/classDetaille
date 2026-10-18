import type { ReactElement } from 'react';
import { NavLink, useParams } from 'react-router';

/** La classe de la page : toujours dans l'URL, jamais déduite d'une session (arbitrage O de la spec). */
export function useClassId(): string {
  const { classId = '' } = useParams();
  return classId;
}

const SECTIONS = [
  { segment: 'demandes', label: 'Demandes' },
  { segment: 'membres', label: 'Membres' },
  { segment: 'matieres', label: 'Matières' },
  { segment: 'statistiques', label: 'Statistiques' },
] as const;

/**
 * Navigation commune des écrans de gestion (M9) : une section, une adresse. `NavLink` pose
 * `aria-current="page"` sur la section courante — inutile de le faire à la main, et risqué de
 * l'oublier.
 */
export function ClassNav({ classId }: { classId: string }): ReactElement {
  return (
    <nav aria-label="Sections de la classe" className="cp-classnav">
      <ul>
        {SECTIONS.map((section) => (
          <li key={section.segment}>
            <NavLink to={`/classes/${classId}/${section.segment}`}>{section.label}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
