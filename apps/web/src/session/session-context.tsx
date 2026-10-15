import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { fetchMe, logout } from '../api/auth';
import type { Me } from '../api/types';

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

export type SessionValue = {
  status: SessionStatus;
  me: Me | null;
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

  const refresh = useCallback(async () => {
    try {
      const profile = await loadMe();
      setMeState(profile);
      setStatus('authenticated');
    } catch {
      // 401, 403 ou réseau : aucune session utilisable. Le serveur fait foi (R4).
      setMeState(null);
      setStatus('anonymous');
    }
  }, [loadMe]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      me,
      setMe: (profile: Me) => {
        setMeState(profile);
        setStatus('authenticated');
      },
      refresh,
      signOut: async () => {
        try {
          await logout();
        } finally {
          setMeState(null);
          setStatus('anonymous');
        }
      },
    }),
    [status, me, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession doit être utilisé sous un SessionProvider');
  return value;
}
