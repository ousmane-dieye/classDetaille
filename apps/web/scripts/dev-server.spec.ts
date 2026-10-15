import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devServerOptions } from './dev-server';

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'cp-web-'));

describe('serveur de développement', () => {
  it('sert en HTTPS avec un certificat auto-signé généré à la demande', async () => {
    const options = await devServerOptions(freshDir());
    expect(options.https.key).toContain('BEGIN');
    expect(options.https.cert).toContain('BEGIN CERTIFICATE');
  });

  it('réutilise le certificat déjà généré', async () => {
    const dir = freshDir();
    const first = (await devServerOptions(dir)).https.cert;
    expect((await devServerOptions(dir)).https.cert).toBe(first);
  });

  it('proxyfie /api vers l’API de développement : une seule origine pour le navigateur', async () => {
    expect((await devServerOptions(freshDir())).proxy['/api']).toBe('http://127.0.0.1:3000');
  });

  it('écoute sur localhost, port 5173', async () => {
    const options = await devServerOptions(freshDir());
    expect(options.host).toBe('localhost');
    expect(options.port).toBe(5173);
  });
});
