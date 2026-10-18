import { useCallback } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { getClassDetail } from '../../api/classes';
import type { ClassDetail } from '../../api/types';
import { Button } from '../../components/Button';
import { InlineAlert } from '../../components/InlineAlert';
import { Skeleton, useDelayedFlag } from '../../components/Skeleton';
import { useSession } from '../../session/session-context';
import { RequireSession } from '../states/require-session';
import { ClassNav, useClassId } from './class-nav';
import { useLoad } from './class-load';

const NOT_FOUND = 'Cette classe n’existe pas ou n’est plus disponible.';

/**
 * M9 (R11) : les trois chiffres de la classe.
 *
 * Ils viennent de `GET /api/classes/:classId` — le serveur les compte, le client ne devine rien.
 * Un `404` vaut autant pour une classe inexistante que pour celle d'un autre compte : l'isolation
 * ne se raconte pas, elle se constate.
 */
function ClassStats(): ReactElement {
  const classId = useClassId();
  const { signOut } = useSession();

  const load = useCallback(() => getClassDetail(classId), [classId]);
  const detail = useLoad<ClassDetail>(load, signOut);

  const showSkeleton = useDelayedFlag(!detail.done);
  const notFound = detail.problem?.status === 404;

  return (
    <div className="cp-page">
      <h1>Statistiques</h1>
      <ClassNav classId={classId} />

      {!detail.done && !showSkeleton ? <p className="cp-field__hint">Chargement…</p> : null}
      {showSkeleton ? (
        <>
          <Skeleton height={56} />
          <Skeleton height={56} />
          <Skeleton height={56} />
        </>
      ) : null}

      {notFound ? (
        <>
          <InlineAlert>{NOT_FOUND}</InlineAlert>
          <Link className="cp-btn cp-btn--secondary" to="/profil">
            Retour à mon profil
          </Link>
        </>
      ) : null}

      {detail.problem && !notFound ? (
        <>
          <InlineAlert>{detail.problem.text}</InlineAlert>
          <Button variant="secondary" onClick={detail.reload}>
            Réessayer
          </Button>
        </>
      ) : null}

      {detail.data ? (
        <ul className="cp-stats">
          <li className="cp-stat">
            <p className="cp-stat__value">{detail.data.stats.members}</p>
            <p className="cp-stat__label">Membres actifs</p>
          </li>
          <li className="cp-stat">
            {/* Le seul chiffre qui appelle à une action ouvre la file d'attente. */}
            <Link className="cp-stat__link" to={`/classes/${classId}/demandes`}>
              <span className="cp-stat__value">{detail.data.stats.pendingRequests}</span>
              {/* L'espace n'est pas décoratif : il sépare les deux mots du nom accessible du lien. */}
              {' '}
              <span className="cp-stat__label">Demandes en attente</span>
            </Link>
          </li>
          <li className="cp-stat">
            <p className="cp-stat__value">{detail.data.stats.decidedRequests}</p>
            <p className="cp-stat__label">Demandes traitées</p>
          </li>
        </ul>
      ) : null}

      {detail.data?.status === 'ARCHIVED' ? (
        <InlineAlert tone="info">
          Cette classe est archivée : elle n’apparaît plus dans les listes et ne peut plus recevoir de demande.
        </InlineAlert>
      ) : null}
    </div>
  );
}

/** M9 : les statistiques d'une classe, réservées à une session ouverte. */
export function ClassStatsScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible de charger les statistiques">
      {() => <ClassStats />}
    </RequireSession>
  );
}
