import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { fetchMe, logout } from '../api/auth';
import { ApiProblem } from '../api/client';
import type { Me } from '../api/types';

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated' | 'unavailable';

export type SessionValue = {
  status: SessionStatus;
  me: Me | null;
  /** Dernière erreur du chargement du profil : permet d'afficher le bon état (§ 3.2). */
  problem: ApiProblem | null;
  /** Enregistre un profil obtenu par une requête (inscription, vérification du code). */
  setMe(me: Me): void;
  /** Recharge le profil depuis le serveur. */
  refresh(): Promise<void>;
  /** Déconnexion : le serveur efface la session, puis l'écran redevient anonyme. */
  signOut(): Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export type SessionProviderProps = {
  children: ReactNode;
  /** Chargement du profil, remplaçable dans les tests. */
  loadMe?: () => Promise<Me>;
};

export function SessionProvider({ children, loadMe = fetchMe }: SessionProviderProps): ReactElement {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [me, setMeState] = useState<Me | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);

  const refresh = useCallback(async () => {
    try {
      const profile = await loadMe();
      setMeState(profile);
      setProblem(null);
      setStatus('authenticated');
    } catch (e) {
      // 401/403 : aucune session. Tout le reste (réseau, 429, 503) : le serveur est indisponible,
      // l'écran affiche alors son état d'erreur et propose de réessayer (UX § 3.2).
      setMeState(null);
      setProblem(
        e instanceof ApiProblem
          ? e
          : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null }),
      );
      setStatus(e instanceof ApiProblem && (e.status === 401 || e.status === 403) ? 'anonymous' : 'unavailable');
    }
  }, [loadMe]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Retour du réseau (M14) : la session se recharge d'elle-même, sans attendre une action.
  useEffect(() => {
    const onOnline = (): void => void refresh();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refresh]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      me,
      problem,
      setMe: (profile: Me) => {
        setMeState(profile);
        setProblem(null);
        setStatus('authenticated');
      },
      refresh,
      signOut: async () => {
        try {
          await logout();
        } catch {
          // Transport indisponible : la déconnexion reste affichée sans erreur, et la session
          // restante sera révélée par le serveur au prochain chargement (le serveur fait foi).
        } finally {
          setMeState(null);
          setProblem(null);
          setStatus('anonymous');
        }
      },
    }),
    [status, me, problem, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession doit être utilisé sous un SessionProvider');
  return value;
}
