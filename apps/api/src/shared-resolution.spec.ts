import { APP_TIME_ZONE, normalizeEmail } from '@classepulse/shared';
import { describe, expect, it } from 'vitest';

describe('résolution de @classepulse/shared (condition « source »)', () => {
  it('importe le TypeScript du paquet depuis l’API', () => {
    expect(APP_TIME_ZONE).toBe('Africa/Dakar');
    expect(normalizeEmail(' A@B.sn ')).toBe('a@b.sn');
  });
});
