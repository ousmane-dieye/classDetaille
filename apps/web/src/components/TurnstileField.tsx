import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { loadTurnstileScript, turnstileSiteKey } from '../api/turnstile';
import { InlineAlert } from './InlineAlert';

type WidgetApi = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
};

export type TurnstileFieldProps = {
  /** Clé publique ; sans clé, le champ n'est pas rendu (R3 : jamais de secret côté client). */
  siteKey?: string;
  /** Jeton à transmettre au serveur, ou `null` dès qu'il n'est plus valable. */
  onChange(token: string | null): void;
  /** Chargement du script, remplaçable dans les tests. */
  loadScript?: () => Promise<void>;
};

const UNAVAILABLE_MESSAGE = 'La vérification anti-robot est indisponible : réessaie dans un instant.';

/** UX § 3.1 et P2 : vérification anti-robot, affichée seulement quand elle est nécessaire. */
export function TurnstileField({ siteKey = turnstileSiteKey(), onChange, loadScript = loadTurnstileScript }: TurnstileFieldProps): ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    setUnavailable(false);
    loadScript()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        const api = (window as unknown as { turnstile?: WidgetApi }).turnstile;
        if (!api) throw new Error('TURNSTILE_MISSING');
        api.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token: string) => onChangeRef.current(token),
          'expired-callback': () => onChangeRef.current(null),
          'error-callback': () => onChangeRef.current(null),
        });
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [siteKey, loadScript]);

  if (!siteKey) return null;
  if (unavailable) return <InlineAlert tone="info">{UNAVAILABLE_MESSAGE}</InlineAlert>;
  return <div className="cp-turnstile" data-testid="cp-turnstile" ref={containerRef} />;
}
