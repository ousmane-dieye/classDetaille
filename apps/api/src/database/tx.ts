const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);
const RETRYABLE_PRISMA_CODES = new Set(['P2034']);

export function codeOf(v: unknown, key: string): string | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const value = (v as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function isRetryableTxError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = codeOf(e, 'code');
  if (code && (RETRYABLE_SQLSTATES.has(code) || RETRYABLE_PRISMA_CODES.has(code))) return true;
  const o = e as Record<string, unknown>;
  const adapterCause = (o.meta as Record<string, unknown> | undefined)?.driverAdapterError;
  const nested = [
    codeOf(o.cause, 'originalCode'),
    codeOf(o.cause, 'code'),
    codeOf(o.meta, 'code'),
    // Prisma 7 + adaptateur pg : { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }
    codeOf((adapterCause as Record<string, unknown> | undefined)?.cause, 'originalCode'),
  ];
  return nested.some((c) => c !== undefined && RETRYABLE_SQLSTATES.has(c));
}

export async function runWithRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isRetryableTxError(e) || attempt === maxAttempts) throw e;
    }
  }
  throw lastError;
}
