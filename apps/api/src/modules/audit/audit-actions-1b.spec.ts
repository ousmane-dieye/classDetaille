import { describe, expect, it } from 'vitest';
import { AUDIT_METADATA } from './audit-actions.js';

describe('actions d’audit du lot 1b (R17)', () => {
  it.each([
    ['ADMIN_LOGIN', { method: 'EMAIL_CODE' }], ['ADMIN_LOGIN', { method: 'RECOVERY_CODE' }],
    ['ADMIN_EMAIL_CHANGED', { revokedSessions: 2 }], ['PASSWORD_RESET_COMPLETED', { revokedSessions: 0 }],
    ['ADMIN_SECOND_FACTOR_BLOCKED', { failures: 10 }],
  ] as const)('%s accepte %j', (action, meta) => {
    expect(AUDIT_METADATA[action].safeParse(meta).success).toBe(true);
  });
  it.each([
    ['ADMIN_LOGIN', { method: 'EMAIL_CODE', ip: '1.2.3.4' }], ['ADMIN_LOGIN', { method: 'TOTP' }],
    ['ADMIN_EMAIL_CHANGED', { revokedSessions: 1, email: 'a@example.com' }], ['PASSWORD_RESET_COMPLETED', {}],
    ['ADMIN_SECOND_FACTOR_BLOCKED', { failures: -1 }],
  ] as const)('%s refuse %j (jamais d’email, d’IP ni de secret)', (action, meta) => {
    expect(AUDIT_METADATA[action].safeParse(meta).success).toBe(false);
  });
});
