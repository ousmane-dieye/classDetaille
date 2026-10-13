import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';

describe('contrastRatio', () => {
  it('noir sur blanc = 21', () => expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1));
  it('blanc sur blanc = 1', () => expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5));
  it('est symétrique', () => expect(contrastRatio('#C2461F', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#C2461F'), 5));
});
