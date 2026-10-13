import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSecretFile } from './secret-file.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-secret-'));
const file = (name: string, content: string) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

describe('readSecretFile', () => {
  it('retire un seul saut de ligne final (LF)', () => {
    expect(readSecretFile(file('lf', 's3cr3t\n'))).toBe('s3cr3t');
  });
  it('retire un seul saut de ligne final (CRLF)', () => {
    expect(readSecretFile(file('crlf', 's3cr3t\r\n'))).toBe('s3cr3t');
  });
  it('conserve les espaces internes et les autres caractères', () => {
    expect(readSecretFile(file('sp', ' a b \n'))).toBe(' a b ');
  });
  it('refuse un fichier vide', () => {
    expect(() => readSecretFile(file('empty', '\n'))).toThrow(/secret file empty/);
  });
  it("refuse un fichier illisible sans révéler de contenu", () => {
    expect(() => readSecretFile(join(dir, 'absent'))).toThrow(/secret file unreadable: .*absent$/);
  });
});
