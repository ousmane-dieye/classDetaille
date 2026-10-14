import { codeOf } from './tx.js';

/** Violation d'unicité, quelle que soit la forme de l'erreur (Prisma P2002 ou SQLSTATE 23505 via l'adaptateur pg). */
export function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  if (codeOf(o, 'code') === 'P2002' || codeOf(o, 'code') === '23505') return true;
  const adapter = (o.meta as Record<string, unknown> | undefined)?.driverAdapterError as Record<string, unknown> | undefined;
  return [codeOf(o.cause, 'code'), codeOf(o.cause, 'originalCode'), codeOf(adapter?.cause, 'originalCode')].includes('23505');
}
