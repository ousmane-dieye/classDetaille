import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

export type CountdownProps = {
  /** Secondes restantes, fournies par le serveur (`expiresInSeconds`, `resendAfterSeconds`, `Retry-After`). */
  seconds: number | null;
  /** Appelé une seule fois quand le décompte atteint zéro. */
  onDone?: () => void;
};

const format = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

/** Compte à rebours lisible (« 08:42 »), annoncé poliment, borné à zéro. */
export function Countdown({ seconds, onDone }: CountdownProps): ReactElement | null {
  const [remaining, setRemaining] = useState<number | null>(seconds);

  useEffect(() => setRemaining(seconds), [seconds]);

  useEffect(() => {
    if (remaining === null || remaining <= 0) return;
    const timer = setInterval(() => setRemaining((r) => (r === null ? r : Math.max(0, r - 1))), 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  useEffect(() => {
    if (remaining === 0) onDone?.();
  }, [remaining, onDone]);

  if (remaining === null) return null;
  return (
    <span className="cp-countdown" aria-live="polite">
      {format(remaining)}
    </span>
  );
}
