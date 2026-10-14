import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readPassword } from './read-password.js';

describe('readPassword (entrée standard non interactive)', () => {
  it('lit la première ligne, sans le saut de ligne, espaces conservés', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    stdin.end(' mot de passe administrateur \nligne ignorée\n');
    await expect(readPassword(stdin as never, new PassThrough() as never)).resolves.toBe(' mot de passe administrateur ');
  });
  it('accepte les fins de ligne Windows', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    stdin.end('secret-windows-1234\r\n');
    await expect(readPassword(stdin as never, new PassThrough() as never)).resolves.toBe('secret-windows-1234');
  });
});
