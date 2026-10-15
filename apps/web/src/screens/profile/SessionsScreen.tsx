import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { listSessions, revokeOtherSessions } from '../../api/account';
import { ApiProblem } from '../../api/client';
import type { Session } from '../../api/types';
import { Button } from '../../components/Button';
import { InlineAlert } from '../../components/InlineAlert';
import { Skeleton, useDelayedFlag } from '../../components/Skeleton';
import { describeUserAgent } from '../../lib/device';
import { formatDateTime, formatLongDate } from '../../lib/format';
import { useSession } from '../../session/session-context';
import { RequireSession } from '../states/require-session';

const toProblem = (e: unknown): ApiProblem =>
  e instanceof ApiProblem ? e : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });

/** § 3.4 et M14 : la liste des appareils connectés, et la déconnexion des autres appareils. */
function Sessions(): ReactElement {
  const { signOut } = useSession();

  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      setSessions(await listSessions());
    } catch (e) {
      const p = toProblem(e);
      // 401 : la session s'est terminée ailleurs. Rendre la page anonyme renvoie à la connexion.
      if (p.status === 401) {
        await signOut();
        return;
      }
      setProblem(p);
      setSessions(null);
    } finally {
      setLoading(false);
    }
  }, [signOut]);

  useEffect(() => {
    void load();
  }, [load]);

  // UX § 3.2 : le squelette ne paraît qu'au-delà de 300 ms, pour ne pas faire clignoter la page.
  const showSkeleton = useDelayedFlag(loading && sessions === null);
  const otherCount = (sessions ?? []).filter((session) => !session.current).length;

  async function revokeOthers(): Promise<void> {
    setRevoking(true);
    try {
      const { revoked } = await revokeOtherSessions();
      setNotice(revoked === 0 ? 'Aucun autre appareil à déconnecter.' : `${revoked} appareil${revoked > 1 ? 's' : ''} déconnecté${revoked > 1 ? 's' : ''}.`);
      setConfirming(false);
      await load();
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 401) {
        await signOut();
        return;
      }
      setProblem(p);
      setConfirming(false);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="cp-page">
      <h1>Sessions actives</h1>

      {loading && sessions === null && !showSkeleton ? <p className="cp-field__hint">Chargement…</p> : null}
      {showSkeleton ? (
        <>
          <Skeleton height={72} />
          <Skeleton height={72} />
        </>
      ) : null}

      {problem ? (
        <>
          <InlineAlert>{problem.text}</InlineAlert>
          <Button variant="secondary" onClick={() => void load()}>
            Réessayer
          </Button>
        </>
      ) : null}
      {notice ? <InlineAlert tone="info">{notice}</InlineAlert> : null}

      {sessions !== null && sessions.length === 0 ? <p>Aucune session active.</p> : null}

      <ul className="cp-sessions">
        {(sessions ?? []).map((session) => (
          <li className="cp-session" key={session.id}>
            <div className="cp-session__body">
              <p className="cp-session__device">{describeUserAgent(session.userAgent)}</p>
              <p className="cp-session__meta">
                {session.current ? 'actif maintenant' : `Dernière activité le ${formatDateTime(session.lastSeenAt)}`}
              </p>
              <p className="cp-session__meta">Session ouverte le {formatLongDate(session.createdAt)}</p>
            </div>
            {session.current ? <span className="cp-session__badge">Cet appareil</span> : null}
          </li>
        ))}
      </ul>

      {otherCount > 0 ? (
        confirming ? (
          <div className="cp-revoke">
            <p>Déconnecter les autres appareils ?</p>
            <div className="cp-row">
              <Button busy={revoking} onClick={() => void revokeOthers()}>
                Déconnecter
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Annuler
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Déconnecter les autres appareils
            </Button>
            <p className="cp-field__hint">Utile si tu t’es connectée sur un ordinateur partagé.</p>
          </>
        )
      ) : null}
    </div>
  );
}

/** M14 : sessions actives, réservées à une session ouverte. */
export function SessionsScreen(): ReactElement {
  return (
    <RequireSession errorTitle="Impossible de charger tes sessions">
      {() => <Sessions />}
    </RequireSession>
  );
}
