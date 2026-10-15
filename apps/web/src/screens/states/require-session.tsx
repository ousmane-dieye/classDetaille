import type { ReactElement, ReactNode } from 'react';
import { Navigate } from 'react-router';
import { Button } from '../../components/Button';
import { StateScreen } from '../../components/StateScreen';
import type { Me } from '../../api/types';
import { useSession } from '../../session/session-context';

export type RequireSessionProps = {
  /** Titre de l'état affiché quand le serveur ne répond pas. */
  errorTitle: string;
  children: (me: Me) => ReactNode;
};

/**
 * États communs d'un écran connecté (UX § 3.2) : chargement, session absente → retour à la
 * connexion, serveur indisponible → erreur et « Réessayer ». Rend le contenu quand le
 * serveur a renvoyé le profil.
 */
export function RequireSession({ errorTitle, children }: RequireSessionProps): ReactElement {
  const { status, me, refresh } = useSession();

  if (status === 'loading') {
    return (
      <StateScreen title="Chargement…">
        <p>Récupération de ta demande.</p>
      </StateScreen>
    );
  }
  if (status === 'anonymous') return <Navigate to="/connexion" replace />;
  if (status === 'unavailable') {
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
        <p>Le serveur ne répond pas pour le moment. Réessaie dans un instant.</p>
      </StateScreen>
    );
  }
  return <>{me ? children(me) : null}</>;
}
