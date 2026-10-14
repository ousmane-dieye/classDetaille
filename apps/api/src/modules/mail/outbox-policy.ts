export const MAX_NORMAL_ATTEMPTS = 5;
/** Délais après la 1ʳᵉ, 2ᵉ, 3ᵉ et 4ᵉ tentative normale (§ 2.4). */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200] as const;
export const AMBIGUOUS_RETRY_DELAY_SECONDS = 900;

export type SendKind = 'ACCEPTED' | 'TEMP_FAIL' | 'PERM_FAIL' | 'AMBIGUOUS';
/** État de l'email au moment de la réservation (le bail garantit que personne d'autre ne le change). */
export type Snapshot = { normalAttempts: number; retryClaimed: boolean };
export type Decision = { status: 'ACCEPTED' | 'RETRY_WAIT' | 'UNCERTAIN' | 'FAILED'; delaySeconds: number | null };

export function nextState(s: Snapshot, outcome: SendKind): Decision {
  if (outcome === 'ACCEPTED') return { status: 'ACCEPTED', delaySeconds: null };
  // Après la reprise ambiguë, tout résultat autre qu'une acceptation donne FAILED.
  if (s.retryClaimed || outcome === 'PERM_FAIL') return { status: 'FAILED', delaySeconds: null };
  if (outcome === 'AMBIGUOUS') return { status: 'UNCERTAIN', delaySeconds: AMBIGUOUS_RETRY_DELAY_SECONDS };
  if (s.normalAttempts >= MAX_NORMAL_ATTEMPTS) return { status: 'FAILED', delaySeconds: null };
  return { status: 'RETRY_WAIT', delaySeconds: RETRY_DELAYS_SECONDS[s.normalAttempts - 1] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1]! };
}
