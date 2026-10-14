import { readFileSync } from 'node:fs';

export class CommonPasswords {
  private readonly set: ReadonlySet<string>;
  constructor(entries: Iterable<string>) { this.set = new Set([...entries].map((e) => e.toLowerCase())); }
  /** `normalized` : mot de passe déjà normalisé (NFKC) ; la comparaison ignore la casse. */
  has(normalized: string): boolean { return this.set.has(normalized.toLowerCase()); }
}

export function loadCommonPasswords(): CommonPasswords {
  const text = readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8');
  return new CommonPasswords(text.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith('#')));
}
