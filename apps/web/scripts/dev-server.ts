import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generate } from 'selfsigned';

export type DevServerOptions = {
  host: string;
  port: number;
  https: { key: string; cert: string };
  proxy: Record<string, string>;
};

const CERT_NAME = 'web-dev';

/** Racine du dépôt : repérée par le fichier d'espace de travail, quel que soit le répertoire de lancement. */
function repoRoot(from = process.cwd()): string {
  let dir = from;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  return from;
}

/**
 * Les cookies `__Host-` sont `Secure` (§ 3.4) : le serveur de développement sert donc en HTTPS,
 * avec un certificat auto-signé généré à la première exécution (jamais committé, `.secrets/` est ignoré).
 * `/api` est proxyfié vers l'API : une seule origine pour le navigateur (§ 3.1), aucun CORS.
 */
export function devServerOptions(secretDir = resolve(repoRoot(), '.secrets/dev')): Promise<DevServerOptions> {
  const keyPath = resolve(secretDir, `${CERT_NAME}.key`);
  const certPath = resolve(secretDir, `${CERT_NAME}.crt`);

  return (async () => {
    if (!existsSync(keyPath) || !existsSync(certPath)) {
      const pems = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
      writeFileSync(keyPath, pems.private, { mode: 0o600 });
      writeFileSync(certPath, pems.cert, { mode: 0o600 });
    }

    return {
      host: 'localhost',
      port: 5173,
      https: { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') },
      proxy: { '/api': 'http://127.0.0.1:3000' },
    };
  })();
}
