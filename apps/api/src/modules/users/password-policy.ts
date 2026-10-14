import { checkPasswordLength, normalizePassword } from '@classepulse/shared';
import type { CommonPasswords } from './common-passwords.js';

export type PasswordRejection = 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'PASSWORD_TOO_COMMON';

/** Règles d'un nouveau mot de passe (§ 0.7) : longueur après NFKC, liste locale ; jamais de troncature. */
export function validateNewPassword(raw: string, role: 'USER' | 'ADMIN', common: CommonPasswords):
  { ok: true; normalized: string } | { ok: false; code: PasswordRejection } {
  const length = checkPasswordLength(raw, role);
  if (length === 'TOO_LONG') return { ok: false, code: 'PASSWORD_TOO_LONG' };
  if (length === 'TOO_SHORT') return { ok: false, code: 'PASSWORD_TOO_SHORT' };
  const normalized = normalizePassword(raw);
  if (common.has(normalized)) return { ok: false, code: 'PASSWORD_TOO_COMMON' };
  return { ok: true, normalized };
}
