import { useCallback } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { listClasses } from '../../api/classes';
import type { ClassAdminSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { InlineAlert } from '../../components/InlineAlert';
import { Skeleton, useDelayedFlag } from '../../components/Skeleton';
import { useSession } from '../../session/session-context';
import { RequireSession } from '../states/require-session';
import { useLoad } from '../gestion/class-load';

/** M11 : toutes les classes, archivées incluses — le seul écran qui les montre toutes. */
function Classes(): ReactElement {
  const { signOut } = useSession();

  const load = useCallback(() => listClasses(), []);
  const classes = useLoad<ClassAdminSummary[]>(load, signOut);
  const showSkeleton = useDelayedFlag(!classes.done);

  return (
    <div className="cp-page">
      <h1>Classes</h1>
      <p className="cp-legend">Toutes les classes, archivées comprises.</p>

      <p>
        <Link className="cp-btn cp-btn--primary" to="/classes/nouvelle">
          Créer une classe
        </Link>
      </p>

      {!classes.done && !showSkeleton ? <p className="cp-field__hint">Chargement…</p> : null}
      {showSkeleton ? (
        <>
          <Skeleton height={64} />
          <Skeleton height={64} />
        </>
      ) : null}

      {classes.problem ? (
        <>
          <InlineAlert>{classes.problem.text}</InlineAlert>
          <Button variant="secondary" onClick={classes.reload}>
            Réessayer
          </Button>
        </>
      ) : null}

      {classes.done && classes.data !== null && classes.data.length === 0 ? (
        <p className="cp-requests__empty">Aucune classe pour le moment.</p>
      ) : null}

      <ul className="cp-classes">
        {(classes.data ?? []).map((klass) => (
          <li className="cp-request" key={klass.id}>
            <Link className="cp-classrow" to={`/classes/${klass.id}`}>
              <span className="cp-request__name">{klass.name}</span>
              <span className="cp-request__meta">
                {klass.level} · {klass.academicYear}
              </span>
            </Link>
            <div className="cp-request__actions">
              <span className="cp-request__meta">{klass.membersCount} étudiants</span>
              {/* Une classe archivée reste visible, mais n'accepte plus rien : on le dit avant d'aller dedans. */}
              {klass.status === 'ARCHIVED' ? <span className="cp-role">Lecture seule</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** M11 : la liste d'administration, réservée à une session ouverte. */
export function ClassesScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible de charger les classes">
      {() => <Classes />}
    </RequireSession>
  );
}
