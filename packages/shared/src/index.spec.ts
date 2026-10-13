import { describe, expect, it } from 'vitest';
import { APP_TIME_ZONE } from './index.js';

describe('shared', () => {
  it('fixe le fuseau de référence de la plateforme', () => {
    expect(APP_TIME_ZONE).toBe('Africa/Dakar');
  });
});
