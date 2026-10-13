import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
// Appel direct via Node (sans shell) : `pnpm` est un .cmd sous Windows.
const cli = join(root, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');

function cruise(target: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [cli, target, '--config', '.dependency-cruiser.cjs', '--output-type', 'err'],
      { cwd: root },
      (err, stdout, stderr) => done({ code: err ? 1 : 0, out: stdout + stderr }),
    );
  });
}

describe('règles d’architecture', () => {
  it('détecte Prisma importé hors d’un repository et un repository étranger', { timeout: 60_000 }, async () => {
    const r = await cruise('apps/api/test/architecture/fixtures/src');
    expect(r.code).toBe(1);
    expect(r.out).toContain('no-prisma-outside-repositories');
    expect(r.out).toContain('alpha.service.ts');
    expect(r.out).toContain('no-foreign-repository');
    expect(r.out).toContain('beta.service.ts');
    expect(r.out).not.toMatch(/no-prisma-outside-repositories[^\n]*alpha\.repository\.ts/);
  });

  it('le code réel de l’API respecte les règles', { timeout: 60_000 }, async () => {
    const r = await cruise('apps/api/src');
    expect(r.code, r.out).toBe(0);
  });
});
