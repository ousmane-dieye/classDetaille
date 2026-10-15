import { useEffect, useState } from 'react';

/**
 * M14 « hors connexion » : l'état du réseau selon le navigateur, tenu à jour par ses événements.
 * `false` désactive les écritures (on ne peut rien promettre) mais laisse la consultation.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
