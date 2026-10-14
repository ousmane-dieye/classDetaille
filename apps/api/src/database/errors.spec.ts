import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './errors.js';

describe('isUniqueViolation', () => {
  it.each([
    [{ code: 'P2002' }, true],
    [{ code: '23505' }, true],
    [{ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '23505' } } } }, true],
    [{ cause: { code: '23505' } }, true],
    [{ code: '23514' }, false],
    [new Error('x'), false],
    [null, false],
  ])('%j → %s', (e, expected) => {
    expect(isUniqueViolation(e)).toBe(expected);
  });
});
