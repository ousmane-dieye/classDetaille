import { describe, expect, it } from 'vitest';
import { isValidName, normalizeName } from './names.js';

describe('normalizeName', () => {
  it('supprime les espaces autour et réduit les espaces internes', () => {
    expect(normalizeName('  Awa   Diop ')).toBe('Awa Diop');
  });
  it('applique NFC', () => {
    const decomposed = 'Ame\u0301lie';
    const composed = 'Am\u00E9lie';
    expect(decomposed).not.toBe(composed);
    expect(normalizeName(decomposed)).toBe(composed);
  });
});

describe('isValidName', () => {
  it('2 à 80 points de code, sans caractère de contrôle ni de format', () => {
    expect(isValidName('Awa')).toBe(true);
    expect(isValidName('A')).toBe(false);
    expect(isValidName('Aw\u0000a')).toBe(false);
    expect(isValidName('Aw\u200Ba')).toBe(false);
    expect(isValidName('x'.repeat(81))).toBe(false);
  });
});
