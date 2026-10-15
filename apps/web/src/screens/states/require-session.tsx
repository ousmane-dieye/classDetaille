import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { Button } from '../../components/Button';
import { Countdown } from '../../components/Countdown';
import { StateScreen } from '../../components/StateScreen';
import type { Me } from '../../api/types';
import { useSession } from '../../session/session-context';

export type RequireSessionProps = {
  /** Titre de l'état affiché quand le serveur ne répond pas. */
  errorTitle: string;
  children: (me: Me) => ReactNode;
};

const MAINTENANCE_TITLE = 'ClassePulse revient très vite';
const MAINTENANCE_TEXT = "On fait une mise à jour. La page se rechargera toute seule dès que c'est terminé.";
const MAINTENANCE_RETRY_SECONDS = 30;
const NOT_FOUND_TITLE = "Cet élément n'existe pas ou n'est plus disponible";
const NOT_FOUND_TEXT = 'Il a peut-être été supprimé, ou tu n’y as plus accès.';
const SERVER_ERROR_TEXT = 'Le serveur ne répond pas pour le moment. Réessaie dans un instant.';

/** M14 : mise à jour, essai automatique — l'écran se recharge de lui-même, sans bouton. */
function Maintenance({ retryAfterSeconds, onRetry }: { retryAfterSeconds: number; onRetry(): void }): ReactElement {
  const [remaining, setRemaining] = useState(retryAfterSeconds);
  const retrying = useRef(false);

  useEffect(() => {
    if (remaining > 0) {
      const timer = setTimeout(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
      return () => clearTimeout(timer);
    }
    // Un seul essai par décompte fini : le rendu suivant repart de zéro.
    if (retrying.current) return undefined;
    retrying.current = true;
    setRemaining(retryAfterSeconds);
    onRetry();
    return undefined;
  }, [remaining, retryAfterSeconds, onRetry]);

  return (
    <StateScreen title={MAINTENANCE_TITLE}>
      <p>{MAINTENANCE_TEXT}</p>
      <p className="cp-state__small">
        Nouvel essai automatique dans <Countdown seconds={remaining} />
      </p>
    </StateScreen>
  );
}

/**
 * États communs d'un écran connecté (UX § 3.2) : chargement, session absente → retour à la
 * connexion en conservant l'écran d'origine, serveur indisponible → l'état juste (maintenance,
 * limite de débit, introuvable ou erreur) avec « Réessayer ». Rend le contenu quand le
 * serveur a renvoyé le profil.
 */
export function RequireSession({ errorTitle, children }: RequireSessionProps): ReactElement {
  const { status, me, refresh, problem } = useSession();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <StateScreen title="Chargement…">
        <p>Récupération de ta demande.</p>
      </StateScreen>
    );
  }

  if (status === 'anonymous') {
    // Retour à l'écran d'origine après connexion : le chemin voyage dans l'état de route,
    // jamais dans l'URL — il ne doit pas traverser le serveur ni l'historique d'un autre.
    return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;
  }

  if (status === 'unavailable' && problem) {
    if (problem.status === 503) {
      return <Maintenance retryAfterSeconds={problem.retryAfterSeconds ?? MAINTENANCE_RETRY_SECONDS} onRetry={() => void refresh()} />;
    }
    if (problem.status === 404) {
      return (
        <StateScreen
          title={NOT_FOUND_TITLE}
          actions={
            <Link className="cp-btn cp-btn--secondary" to="/">
              Retour à l&apos;accueil
            </Link>
          }
        >
          <p>{NOT_FOUND_TEXT}</p>
        </StateScreen>
      );
    }
    const retryIn = problem.retryAfterSeconds ?? 0;
    const rateLimited = problem.status === 429;
    return (
      <StateScreen
        title={errorTitle}
        tone="error"
        actions={
          <Button variant="secondary" onClick={() => void refresh()}>
            Réessayer
          </Button>
        }
      >
        <p>{rateLimited ? problem.text : SERVER_ERROR_TEXT}</p>
        {retryIn > 0 ? (
          <p className="cp-state__small">
            Réessaie dans <Countdown seconds={retryIn} />
          </p>
        ) : null}
        {/* M14 : la référence aide l'assistance, elle ne dit rien de la panne. */}
        {problem.requestId ? <p className="cp-state__rid">Référence : {problem.requestId}</p> : null}
      </StateScreen>
    );
  }

  return <>{me ? children(me) : null}</>;
}
