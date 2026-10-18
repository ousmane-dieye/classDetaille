import { useCallback, useEffect, useState } from 'react';
import { ApiProblem } from '../../api/client';

/** Une erreur non reconnue reste un problème interne : jamais une trace, jamais un code nu. */
export const toProblem = (e: unknown): ApiProblem =>
  e instanceof ApiProblem
    ? e
    : new ApiProblem({ status: 0, code: 'INTERNAL', extra: {}, requestId: '', retryAfterSeconds: null });

export type LoadState<T> = {
  data: T | null;
  problem: ApiProblem | null;
  /** Le chargement est fini — réussi ou non : l'écran cesse d'afficher l'état de chargement. */
  done: boolean;
  reload(): void;
};

/**
 * Le chargement des écrans de gestion, écrit une fois pour les trois sections (M9).
 *
 * `fetcher` et `onUnauthorized` doivent être stables ( `useCallback` ) : ils font partie des
 * dépendances. Un `401` appelle `onUnauthorized` et ne pose aucun message — c'est la page
 * anonyme qui prend le relais et ramène à la connexion.
 */
export function useLoad<T>(fetcher: () => Promise<T>, onUnauthorized: () => Promise<void>): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [done, setDone] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setProblem(null);
    setDone(false);
    void fetcher()
      .then((value) => {
        if (!alive) return;
        setData(value);
        setDone(true);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const p = toProblem(e);
        if (p.status === 401) {
          void onUnauthorized();
          return;
        }
        setData(null);
        setProblem(p);
        setDone(true);
      });
    return () => {
      alive = false;
    };
  }, [fetcher, onUnauthorized, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, problem, done, reload };
}
