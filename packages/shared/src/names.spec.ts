import { describe, expect, it } from 'vitest';
import { normalizeName } from './names.js';

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
