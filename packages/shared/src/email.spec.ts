import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isAcceptedEmail, normalizeEmail } from './email.js';

describe('normalizeEmail (§ 2.1 : espaces, NFKC, minuscules)', () => {
  it.each([
    ['  Alice@Example.COM ', 'alice@example.com'],
    ['\uFF21\uFF2C\uFF29\uFF23\uFF25@example.com', 'alice@example.com'], // pleine largeur → ASCII par NFKC
    ['alice@example.com', 'alice@example.com'],
    ['\talice@example.com\n', 'alice@example.com'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });
  it('est idempotente sur les emails acceptés (chaînes binaires arbitraires)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const n = normalizeEmail(s);
        return !isAcceptedEmail(n) || normalizeEmail(n) === n;
      }),
    );
  });
});

describe('isAcceptedEmail (ASCII seulement au MVP)', () => {
  it.each(['alice@example.com', 'a.b+c@sub.example.sn', "o'brien@example.org"])('accepte %s', (e) => {
    expect(isAcceptedEmail(e)).toBe(true);
  });
  it.each([
    '',
    'alice',
    'alice@',
    '@example.com',
    'alice@localhost',
    '\u00E9lise@example.com',
    'alice@ex\u00E4mple.com',
    'a b@example.com',
    `${'a'.repeat(250)}@example.com`,
  ])('refuse %j', (e) => {
    expect(isAcceptedEmail(e)).toBe(false);
  });
});
