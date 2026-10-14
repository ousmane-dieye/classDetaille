import { envSchema } from './config.schema.js';
import { readSecretFile } from './secret-file.js';

export type DbAuth =
  | { mode: 'password'; password: string }
  | { mode: 'cert'; caFile: string; certFile: string; keyFile: string; p12File?: string; p12Password?: string };

export type DbConfig = { host: string; port: number; database: string; user: string; auth: DbAuth };

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  httpPort: number;
  readyPort: number;
  /** Adresse d'écoute du serveur interne de disponibilité (127.0.0.1 par défaut : seul le contrôle de santé Docker, dans le conteneur, l'interroge). */
  readyHost: string;
  db: DbConfig;
};

// PGPASSWORD / PGPASSFILE : lus implicitement par la bibliothèque pg, ils contourneraient les fichiers *_FILE.
const FORBIDDEN_DIRECT_SECRETS = ['DB_PASSWORD', 'DATABASE_URL', 'PGPASSWORD', 'PGPASSFILE'] as const;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  for (const key of FORBIDDEN_DIRECT_SECRETS) {
    if (env[key] !== undefined) throw new Error(`${key} must not be set: use a *_FILE secret`);
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid configuration: ${names}`);
  }
  const e = parsed.data;
  let auth: DbAuth;
  if (e.DB_AUTH_MODE === 'password') {
    if (e.NODE_ENV === 'production') throw new Error('password mode is not allowed in production');
    if (!e.DB_PASSWORD_FILE) throw new Error('invalid configuration: DB_PASSWORD_FILE');
    auth = { mode: 'password', password: readSecretFile(e.DB_PASSWORD_FILE) };
  } else {
    if (!e.DB_SSL_CA_FILE || !e.DB_SSL_CERT_FILE || !e.DB_SSL_KEY_FILE) {
      throw new Error('invalid configuration: DB_SSL_CA_FILE, DB_SSL_CERT_FILE, DB_SSL_KEY_FILE');
    }
    auth = { mode: 'cert', caFile: e.DB_SSL_CA_FILE, certFile: e.DB_SSL_CERT_FILE, keyFile: e.DB_SSL_KEY_FILE };
    if (e.DB_SSL_P12_FILE) auth.p12File = e.DB_SSL_P12_FILE;
    if (e.DB_SSL_P12_PASSWORD_FILE) auth.p12Password = readSecretFile(e.DB_SSL_P12_PASSWORD_FILE);
  }
  return {
    nodeEnv: e.NODE_ENV,
    httpPort: e.HTTP_PORT,
    readyPort: e.READY_PORT,
    readyHost: e.READY_HOST,
    db: { host: e.DB_HOST, port: e.DB_PORT, database: e.DB_NAME, user: e.DB_USER, auth },
  };
}
