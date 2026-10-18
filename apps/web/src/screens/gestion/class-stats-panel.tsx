import type { ReactElement } from 'react';
import { Link } from 'react-router';
import type { ClassStats } from '../../api/types';

/**
 * Les trois chiffres (R11), posés une fois pour les deux adresses qui les montrent :
 * la section « Statistiques » et la fiche de la classe.
 *
 * Le serveur les compte ; le client n'additionne rien. Le seul chiffre qui appelle à une
 * action — les demandes en attente — est un lien, et le soulignement (jamais la seule
 * couleur) le signale.
 */
export function ClassStatsPanel({ stats, classId }: { stats: ClassStats; classId: string }): ReactElement {
  return (
    <ul className="cp-stats">
      <li className="cp-stat">
        <p className="cp-stat__value">{stats.members}</p>
        <p className="cp-stat__label">Membres actifs</p>
      </li>
      <li className="cp-stat">
        <Link className="cp-stat__link" to={`/classes/${classId}/demandes`}>
          <span className="cp-stat__value">{stats.pendingRequests}</span>
          {/* L'espace n'est pas décoratif : il sépare les deux mots du nom accessible du lien. */}
          {' '}
          <span className="cp-stat__label">Demandes en attente</span>
        </Link>
      </li>
      <li className="cp-stat">
        <p className="cp-stat__value">{stats.decidedRequests}</p>
        <p className="cp-stat__label">Demandes traitées</p>
      </li>
    </ul>
  );
}
