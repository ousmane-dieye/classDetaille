import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HEADER = /^-- classification: (expand|contract|irreversible)\s*$/;
const NON_TX = /^--\s*non-transactional\s*$/m;

/** Instructions SQL hors commentaires de ligne (découpage simple sur `;`, suffisant pour une migration non transactionnelle). */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Renvoie les violations des règles de migration (§ 7.8) : `<dossier>: <règle>`. */
export function checkMigrations(dir: string): string[] {
  const problems: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, entry.name, 'migration.sql');
    if (!existsSync(file)) { problems.push(`${entry.name}: missing migration.sql`); continue; }
    const sql = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const first = sql.split('\n')[0] ?? '';
    const header = HEADER.exec(first);
    if (!header) problems.push(`${entry.name}: missing classification header`);
    if (NON_TX.test(sql)) {
      if (statements(sql).length !== 1) problems.push(`${entry.name}: non-transactional migration must contain exactly one statement`);
      if (header && header[1] !== 'expand') problems.push(`${entry.name}: non-transactional migration must be classified expand`);
    } else {
      if (!/^\s*BEGIN;\s*$/m.test(sql)) problems.push(`${entry.name}: missing BEGIN;`);
      if (!/^\s*COMMIT;\s*$/m.test(sql)) problems.push(`${entry.name}: missing COMMIT;`);
    }
  }
  return problems;
}

describe('règles des migrations', () => {
  it('les migrations réelles respectent les règles (en-tête, transaction explicite)', () => {
    const real = resolve(import.meta.dirname, '../../prisma/migrations');
    expect(readdirSync(real, { withFileTypes: true }).some((e) => e.isDirectory())).toBe(true);
    expect(checkMigrations(real)).toEqual([]);
  });

  it('le contrôle détecte chaque violation (fixtures)', () => {
    const fixtures = resolve(import.meta.dirname, 'fixtures-migrations');
    expect(checkMigrations(fixtures)).toEqual([
      '20990101000001_no_header: missing classification header',
      '20990101000002_no_begin: missing BEGIN;',
      '20990101000002_no_begin: missing COMMIT;',
      '20990101000004_nontx_two_statements: non-transactional migration must contain exactly one statement',
      '20990101000005_nontx_contract: non-transactional migration must be classified expand',
    ]);
  });
});
