const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const SCRIPT_ID = 'cp-turnstile-script';

let pending: Promise<void> | null = null;

/**
 * Charge le widget officiel de Cloudflare une seule fois (UX § 5.3 : chargé à la demande).
 * Le script est public ; aucun secret ne passe par le navigateur.
 */
export function loadTurnstileScript(doc: Document = document): Promise<void> {
  if (typeof window !== 'undefined' && 'turnstile' in window) return Promise.resolve();
  if (pending) return pending;

  pending = new Promise<void>((resolve, reject) => {
    const existing = doc.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? doc.createElement('script');
    script.id = SCRIPT_ID;
    script.setAttribute('data-cp-turnstile', '');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => {
      // Un nouvel essai reste possible : on oublie la promesse en échec.
      pending = null;
      reject(new Error('TURNSTILE_SCRIPT_FAILED'));
    });
    if (!existing) doc.head.appendChild(script);
  });
  return pending;
}

/** Clé publique (`VITE_TURNSTILE_SITEKEY`). Absente : le widget n'est pas rendu (R3). */
export function turnstileSiteKey(): string {
  const value = import.meta.env.VITE_TURNSTILE_SITEKEY;
  return typeof value === 'string' ? value : '';
}
