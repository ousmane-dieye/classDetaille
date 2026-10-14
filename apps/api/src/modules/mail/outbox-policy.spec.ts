import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AMBIGUOUS_RETRY_DELAY_SECONDS, RETRY_DELAYS_SECONDS, nextState, type SendKind } from './outbox-policy.js';

describe('nextState (§ 2.4)', () => {
  it.each([1, 2, 3, 4])('échec temporaire à la tentative normale %i : nouvelle tentative après le délai prévu', (n) => {
    expect(nextState({ normalAttempts: n, retryClaimed: false }, 'TEMP_FAIL')).toEqual({ status: 'RETRY_WAIT', delaySeconds: RETRY_DELAYS_SECONDS[n - 1] });
  });
  it('les délais sont 1 min, 5 min, 30 min, 2 h', () => {
    expect([...RETRY_DELAYS_SECONDS]).toEqual([60, 300, 1800, 7200]);
  });
  it('échec temporaire à la 5ᵉ tentative normale : FAILED', () => {
    expect(nextState({ normalAttempts: 5, retryClaimed: false }, 'TEMP_FAIL')).toEqual({ status: 'FAILED', delaySeconds: null });
  });
  it('échec définitif : FAILED à tout moment', () => {
    expect(nextState({ normalAttempts: 1, retryClaimed: false }, 'PERM_FAIL').status).toBe('FAILED');
  });
  it.each([1, 3, 5])('résultat ambigu à la tentative normale %i : une reprise dans 15 min', (n) => {
    expect(nextState({ normalAttempts: n, retryClaimed: false }, 'AMBIGUOUS')).toEqual({ status: 'UNCERTAIN', delaySeconds: AMBIGUOUS_RETRY_DELAY_SECONDS });
  });
  it.each<SendKind>(['TEMP_FAIL', 'PERM_FAIL', 'AMBIGUOUS'])('après la reprise ambiguë, %s donne FAILED', (o) => {
    expect(nextState({ normalAttempts: 2, retryClaimed: true }, o)).toEqual({ status: 'FAILED', delaySeconds: null });
  });
  it('une acceptation est toujours ACCEPTED, même à la reprise', () => {
    expect(nextState({ normalAttempts: 5, retryClaimed: true }, 'ACCEPTED')).toEqual({ status: 'ACCEPTED', delaySeconds: null });
  });
});

describe('cycle de vie (propriété)', () => {
  type Status = 'PENDING' | 'RETRY_WAIT' | 'UNCERTAIN' | 'ACCEPTED' | 'FAILED';
  function run(outcomes: SendKind[]) {
    let snap = { normalAttempts: 0, retryClaimed: false };
    let status: Status = 'PENDING';
    let attempts = 0;
    let retries = 0;
    for (const o of outcomes) {
      if (status === 'ACCEPTED' || status === 'FAILED') break;
      if (status === 'UNCERTAIN') { snap = { ...snap, retryClaimed: true }; retries++; } else snap = { ...snap, normalAttempts: snap.normalAttempts + 1 };
      attempts++;
      status = nextState(snap, o).status;
    }
    return { status, attempts, retries };
  }
  it('jamais plus de 6 tentatives ni de 1 reprise ; toujours terminé après 6 résultats', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom<SendKind>('TEMP_FAIL', 'PERM_FAIL', 'AMBIGUOUS', 'ACCEPTED'), { minLength: 6, maxLength: 12 }), (outcomes) => {
      const r = run(outcomes);
      return r.attempts <= 6 && r.retries <= 1 && (r.status === 'ACCEPTED' || r.status === 'FAILED');
    }));
  });
  it('quatre échecs temporaires, un résultat ambigu au 5ᵉ essai, puis un échec : 6 tentatives exactement', () => {
    expect(run(['TEMP_FAIL', 'TEMP_FAIL', 'TEMP_FAIL', 'TEMP_FAIL', 'AMBIGUOUS', 'TEMP_FAIL'])).toEqual({ status: 'FAILED', attempts: 6, retries: 1 });
  });
});

describe('cohérence avec le SQL (D15)', () => {
  it('tout délai exprimé en minutes dans la migration de l’outbox est un délai de la politique', () => {
    const sql = readFileSync(new URL('../../../prisma/migrations/20261014000300_email_outbox/migration.sql', import.meta.url), 'utf8');
    const seconds = [...sql.matchAll(/interval '(\d+) minutes?'/g)].map((m) => Number(m[1]) * 60);
    const allowed = new Set<number>([...RETRY_DELAYS_SECONDS, AMBIGUOUS_RETRY_DELAY_SECONDS]);
    for (const s of seconds) expect(allowed.has(s)).toBe(true);
  });
});
