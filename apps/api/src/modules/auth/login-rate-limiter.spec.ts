import { describe, expect, it } from 'vitest';
import { backoffSeconds } from './login-rate-limiter.js';

describe('backoffSeconds (R5 : délai croissant)', () => {
  it.each([[0, 0], [1, 1], [2, 2], [3, 4], [4, 8], [5, 16], [6, 30], [20, 30]])('%d échec(s) → %d s', (n, s) => {
    expect(backoffSeconds(n)).toBe(s);
  });
});
