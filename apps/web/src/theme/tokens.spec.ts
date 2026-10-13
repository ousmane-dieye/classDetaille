import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { renderTokensCss, tokens } from './tokens';

describe('couleurs de la direction B (UX § 4.1)', () => {
  it('reprennent exactement les valeurs validées (thème clair)', () => {
    expect(tokens.light).toMatchObject({ bg: '#FFF9F4', surface: '#FFFFFF', ink: '#2A211C', brand: '#C2461F', onbrand: '#FFFFFF', red: '#B42318', amb: '#A15C07', grn: '#1E7A46' });
  });
  it('reprennent exactement les valeurs validées (thème sombre)', () => {
    expect(tokens.dark).toMatchObject({ bg: '#1A1411', surface: '#241C18', ink: '#F6EDE6', brand: '#E8703F', onbrand: '#1A1411', brandtx: '#F08A5D', red: '#FF8A7A', amb: '#F2C063', grn: '#72D49B' });
  });
  it.each(['light', 'dark'] as const)('contraste AA du texte dans le thème %s', (mode) => {
    const t = tokens[mode];
    for (const [fg, bg] of [[t.ink, t.bg], [t.ink, t.surface], [t.onbrand, t.brand], [t.brandtx, t.surface], [t.red, t.surface], [t.amb, t.surface], [t.grn, t.surface]] as const) {
      expect(contrastRatio(fg, bg), `${fg} sur ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('tokens.css est à jour (pnpm --filter @classepulse/web gen:tokens)', () => {
    const onDisk = readFileSync(resolve(import.meta.dirname, 'tokens.css'), 'utf8');
    expect(onDisk).toBe(renderTokensCss(tokens));
  });
});
