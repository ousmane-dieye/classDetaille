import { describe, expect, it } from 'vitest';
import { dbMessageOf, isUniqueViolation } from './errors.js';

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

describe('dbMessageOf', () => {
  it('lit le message sous toutes les enveloppes (adaptateur pg inclus)', () => {
    expect(dbMessageOf({ message: 'enrollment: refused less than 24 hours ago' })).toContain('refused less than 24 hours');
    expect(dbMessageOf({ code: 'P2010', meta: { driverAdapterError: { cause: { originalMessage: 'membership: user is already a member' } } } })).toContain('already a member');
    expect(dbMessageOf({ cause: { message: 'duplicate key value violates unique constraint "enrollment_one_pending"' } })).toContain('enrollment_one_pending');
  });
  it('ignore les enveloppes sans message et les cycles', () => {
    const a: Record<string, unknown> = { code: '23514' };
    a.cause = a;
    expect(dbMessageOf(a)).toBe('');
    expect(dbMessageOf(null)).toBe('');
  });
});
