import { describe, expect, it } from 'vitest';
import { ApiError } from '../../http/errors.js';
import { AuthzService } from './authz.service.js';

describe('AuthzService.assert', () => {
  it('laisse passer une action autorisée', () => {
    expect(() => new AuthzService().assert({ kind: 'anonymous', ip: '1.2.3.4' }, 'auth.login')).not.toThrow();
  });
  it('lève 403 FORBIDDEN sinon', () => {
    try {
      new AuthzService().assert({ kind: 'anonymous', ip: '1.2.3.4' }, 'me.read');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).getStatus()).toBe(403);
      expect((e as ApiError).code).toBe('FORBIDDEN');
    }
  });
});
