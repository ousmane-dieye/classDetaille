import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Formes interdites (G4), insensibles à la casse et aux blancs (retours à la ligne compris).
 * PostgreSQL ne permet pas d'interdire `log_parameter_max_length_on_error` (contexte « user ») :
 * ce garde-fou empêche le code, les migrations et les scripts SQL de le modifier.
 */
export const FORMS = {
  'set': /\bset\s+(?:session\s+|local\s+)?"?log_/i,
  'set_config': /\bset_config\s*\(\s*(?:E?'|")log_/i,
  'alter-role': /\balter\s+(?:role|user)\b[^;]*?\bset\s+"?log_/i,
  'alter-database': /\balter\s+database\b[^;]*?\bset\s+"?log_/i,
  'log_parameter_max_length': /log_parameter_max_length/i,
} as const;
export type Form = keyof typeof FORMS;

type Target = { dir: string; ext: string; exclude?: string };

function files(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p, ext) : e.name.endsWith(ext) ? [p] : [];
  });
}

/** Renvoie, pour chaque fichier fautif, les formes interdites qu'il contient. */
export function scanForLogSettings(targets: Target[]): { file: string; forms: Form[] }[] {
  return targets
    .flatMap((t) => files(t.dir, t.ext).filter((f) => !t.exclude || relative(t.exclude, f).startsWith('..')))
    .map((file) => {
      const text = readFileSync(file, 'utf8');
      return { file, forms: (Object.keys(FORMS) as Form[]).filter((k) => FORMS[k].test(text)) };
    })
    .filter((r) => r.forms.length > 0);
}

const api = resolve(import.meta.dirname, '../..');
const repo = resolve(api, '../..');

describe('garde-fou G4 : aucun réglage log_* dans le code, les migrations ni les scripts SQL', () => {
  it('apps/api/src, apps/api/prisma/migrations et db/ ne contiennent aucune forme interdite', () => {
    const src = join(api, 'src');
    const found = scanForLogSettings([
      { dir: src, ext: '.ts', exclude: join(src, 'generated') },
      { dir: join(api, 'prisma', 'migrations'), ext: '.sql' },
      { dir: join(repo, 'db'), ext: '.sql' },
    ]);
    expect(found.map((f) => relative(repo, f.file))).toEqual([]);
  });

  it('le scan couvre bien les trois emplacements (fichiers présents)', () => {
    expect(files(join(api, 'src'), '.ts').length).toBeGreaterThan(0);
    expect(files(join(api, 'prisma', 'migrations'), '.sql').length).toBeGreaterThan(0);
    expect(files(join(repo, 'db'), '.sql').length).toBeGreaterThan(0);
  });

  it('chaque forme interdite est détectée (fixtures), le fichier sain ne l’est pas', () => {
    const fixtures = resolve(import.meta.dirname, 'fixtures-log');
    const found = scanForLogSettings([{ dir: fixtures, ext: '.ts' }, { dir: fixtures, ext: '.sql' }]);
    const byFile = Object.fromEntries(found.map((f) => [relative(fixtures, f.file), f.forms]));
    expect(byFile).toEqual({
      'alter-database.sql': ['set', 'alter-database'],
      'alter-role.sql': ['set', 'alter-role'],
      'alter-user.sql': ['set', 'alter-role'],
      'max-length.ts': ['log_parameter_max_length'],
      'set-config-double.ts': ['set_config'],
      'set-config-single.ts': ['set_config'],
      'set-local.ts': ['set'],
      'set-plain.sql': ['set'],
      'set-session.sql': ['set'],
      'violation.ts': ['set', 'log_parameter_max_length'],
    });
    // Toutes les formes sont couvertes par au moins une fixture.
    expect(new Set(found.flatMap((f) => f.forms))).toEqual(new Set(Object.keys(FORMS)));
  });
});
