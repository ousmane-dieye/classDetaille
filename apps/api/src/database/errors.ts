import { codeOf } from './tx.js';

/** Violation d'unicité, quelle que soit la forme de l'erreur (Prisma P2002 ou SQLSTATE 23505 via l'adaptateur pg). */
export function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  if (codeOf(o, 'code') === 'P2002' || codeOf(o, 'code') === '23505') return true;
  const adapter = (o.meta as Record<string, unknown> | undefined)?.driverAdapterError as Record<string, unknown> | undefined;
  return [codeOf(o.cause, 'code'), codeOf(o.cause, 'originalCode'), codeOf(adapter?.cause, 'originalCode')].includes('23505');
}

/** Message SQL (déclencheurs, contraintes), lu sous toutes les formes de l'erreur Prisma/adaptateur pg. */
export function dbMessageOf(e: unknown): string {
  const seen = new Set<unknown>();
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 5 || typeof v !== 'object' || v === null || seen.has(v)) return;
    seen.add(v);
    const o = v as Record<string, unknown>;
    for (const k of ['message', 'originalMessage'] as const) {
      const m = o[k];
      if (typeof m === 'string') out.push(m);
    }
    walk(o.cause, depth + 1);
    walk((o.meta as Record<string, unknown> | undefined)?.driverAdapterError, depth + 1);
  };
  walk(e, 0);
  return out.join(' | ');
}
