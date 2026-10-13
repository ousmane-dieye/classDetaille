import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = /set\s+log_|set\s+local\s+log_|set_config\s*\(\s*'log_|log_parameter_max_length/i;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

export function scanForLogSettings(root: string, excludeDir?: string): string[] {
  return tsFiles(root)
    .filter((f) => !excludeDir || relative(excludeDir, f).startsWith('..'))
    .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')));
}

describe('garde-fou G4 : aucune instruction SET log_* dans le code', () => {
  it('apps/api/src ne contient aucune instruction de réglage de journalisation', () => {
    const src = resolve(import.meta.dirname, '../../src');
    expect(scanForLogSettings(src, join(src, 'generated'))).toEqual([]);
  });

  it('le scan détecte une violation (fixture)', () => {
    const fixtures = resolve(import.meta.dirname, 'fixtures-log');
    const found = scanForLogSettings(fixtures);
    expect(found.map((f) => relative(fixtures, f))).toEqual(['violation.ts']);
  });
});
