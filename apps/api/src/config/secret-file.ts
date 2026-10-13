import { readFileSync } from 'node:fs';

export function readSecretFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`secret file unreadable: ${path}`);
  }
  const value = raw.replace(/\r?\n$/, '');
  if (value.length === 0) throw new Error(`secret file empty: ${path}`);
  return value;
}
