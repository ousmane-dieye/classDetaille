import { describe, expect, it } from 'vitest';
import { tooManyAttempts, tooManyRequests } from './too-many-attempts.js';

describe('429 commun', () => {
  it('code, corps et Retry-After entier d’au moins 1', () => {
    const e = tooManyAttempts(4.2);
    expect([e.getStatus(), e.code, e.extra, e.headers]).toEqual([429, 'TOO_MANY_ATTEMPTS', { retryAfter: 5 }, { 'retry-after': '5' }]);
    expect(tooManyRequests('TOO_MANY_CODE_REQUESTS', 0).headers).toEqual({ 'retry-after': '1' });
  });
});
