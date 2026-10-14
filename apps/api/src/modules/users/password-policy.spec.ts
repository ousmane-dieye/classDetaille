import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CommonPasswords, loadCommonPasswords } from './common-passwords.js';
import { validateNewPassword } from './password-policy.js';

const common = new CommonPasswords(['motdepassedelaclasse', 'ilovemyclasse2026']);

describe('validateNewPassword (§ 0.7)', () => {
  it('normalise (NFKC) et accepte 15 caractères pour un étudiant', () => {
    expect(validateNewPassword('ﬁ'.repeat(8), 'USER', common)).toEqual({ ok: true, normalized: 'fi'.repeat(8) });
  });
  it.each([
    ['a'.repeat(14), 'USER', 'PASSWORD_TOO_SHORT'],
    ['a'.repeat(15), 'ADMIN', 'PASSWORD_TOO_SHORT'],
    ['a'.repeat(129), 'USER', 'PASSWORD_TOO_LONG'],
    ['MotDePasseDeLaClasse', 'USER', 'PASSWORD_TOO_COMMON'], // comparaison en minuscules
  ] as const)('%j (%s) → %s', (p, role, code) => {
    expect(validateNewPassword(p, role, common)).toEqual({ ok: false, code });
  });
  it('aucune règle de composition', () => {
    expect(validateNewPassword('aaaaaaaaaaaaaaa', 'USER', common).ok).toBe(true);
  });
});

describe('liste locale', () => {
  it('se charge et reconnaît une entrée du fichier, quelle que soit la casse', () => {
    const lines = readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    const list = loadCommonPasswords();
    expect(lines.length).toBeGreaterThan(0);
    expect(list.has(lines[0]!)).toBe(true);
    expect(list.has(lines[0]!.toUpperCase())).toBe(true);
  });
});
