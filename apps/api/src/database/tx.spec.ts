import { describe, expect, it, vi } from 'vitest';
import { isRetryableTxError, runWithRetry } from './tx.js';

const pgErr = (code: string) => Object.assign(new Error(code), { code });

describe('isRetryableTxError', () => {
  it.each([
    [pgErr('40P01'), true],
    [pgErr('40001'), true],
    [{ code: 'P2034' }, true],
    [{ cause: { originalCode: '40P01' } }, true],
    [{ meta: { code: '40001' } }, true],
    [{ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01', kind: 'TransactionWriteConflict' } } } }, true],
    [{ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '23505' } } } }, false],
    [pgErr('23505'), false],
    [new Error('boom'), false],
    [undefined, false],
  ])('%o → %s', (e, expected) => expect(isRetryableTxError(e)).toBe(expected));
});

describe('runWithRetry', () => {
  it('réessaie jusqu’au succès', async () => {
    const fn = vi.fn().mockRejectedValueOnce(pgErr('40P01')).mockResolvedValueOnce('ok');
    await expect(runWithRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('abandonne après 3 essais et renvoie la dernière erreur d’origine', async () => {
    const last = pgErr('40001');
    const fn = vi.fn().mockRejectedValueOnce(pgErr('40P01')).mockRejectedValueOnce(pgErr('40P01')).mockRejectedValueOnce(last);
    await expect(runWithRetry(fn)).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('ne réessaie pas une erreur non concernée', async () => {
    const e = pgErr('23505');
    const fn = vi.fn().mockRejectedValue(e);
    await expect(runWithRetry(fn)).rejects.toBe(e);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
