import { ApiError } from './errors.js';

/** 429 avec `Retry-After` (secondes entières, au moins 1) : construction unique pour toutes les limites. */
export function tooManyRequests(code: string, retryAfterSeconds: number): ApiError {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
  return new ApiError(429, code, { retryAfter }, { 'retry-after': String(retryAfter) });
}

export const tooManyAttempts = (retryAfterSeconds: number): ApiError => tooManyRequests('TOO_MANY_ATTEMPTS', retryAfterSeconds);
