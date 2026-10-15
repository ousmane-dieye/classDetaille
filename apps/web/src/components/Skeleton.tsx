import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

/** UX § 3.2 : une forme grise imitant la page, affichée seulement au-delà de 300 ms. */
export function useDelayedFlag(active: boolean, delayMs = 300): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return shown;
}

export function Skeleton({ height = 24 }: { height?: number }): ReactElement {
  return <div className="cp-skeleton" style={{ height }} aria-hidden="true" />;
}
