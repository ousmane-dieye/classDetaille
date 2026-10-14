import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX, PASSWORD_MIN, checkPasswordLength, normalizePassword, passwordLength } from './password.js';

describe('mots de passe (§ 0.7)', () => {
  it('constantes', () => {
    expect(PASSWORD_MIN).toEqual({ USER: 15, ADMIN: 16 });
    expect(PASSWORD_MAX).toBe(128);
  });
  it('NFKC : la ligature ﬃ devient ffi', () => {
    expect(normalizePassword('\uFB03')).toBe('ffi');
  });
  it('compte en points de code après NFKC (emoji = 1, é décomposé = 1)', () => {
    expect(passwordLength('\u{1F600}')).toBe(1);
    expect(passwordLength('e\u0301')).toBe(1); // NFKC compose e + accent
  });
  it.each([
    ['a'.repeat(14), 'USER', 'TOO_SHORT'],
    ['a'.repeat(15), 'USER', null],
    ['a'.repeat(15), 'ADMIN', 'TOO_SHORT'],
    ['a'.repeat(16), 'ADMIN', null],
    ['a'.repeat(128), 'USER', null],
    ['a'.repeat(129), 'USER', 'TOO_LONG'],
    ['\uFB03'.repeat(43), 'USER', 'TOO_LONG'], // 43 caractères saisis, 129 après NFKC
    ['e\u0301'.repeat(15), 'USER', null], // 30 unités saisies, 15 points de code après NFKC
    ['e\u0301'.repeat(14), 'USER', 'TOO_SHORT'],
  ] as const)('%j (%s) → %s', (p, role, expected) => {
    expect(checkPasswordLength(p, role)).toBe(expected);
  });
});
