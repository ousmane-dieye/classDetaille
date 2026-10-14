import { dbEnvSchema, envSchema } from './config.schema.js';
import { readSecretFile } from './secret-file.js';

export type DbAuth =
  | { mode: 'password'; password: string }
  | { mode: 'cert'; caFile: string; certFile: string; keyFile: string; p12File?: string; p12Password?: string };

export type DbConfig = { host: string; port: number; database: string; user: string; auth: DbAuth };

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'silent';

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  httpPort: number;
  readyPort: number;
  /** Adresse d'écoute du serveur interne de disponibilité (127.0.0.1 par défaut : seul le contrôle de santé Docker, dans le conteneur, l'interroge). */
  readyHost: string;
  db: DbConfig;
  /** `origin` : origine exacte de l'application web (CSRF, § 3.5) ; `trustProxy` : nombre de mandataires de confiance. */
  http: { origin: string; trustProxy: number; logLevel: LogLevel };
  security: { rateLimitHmacKey: string };
  turnstile: { secret: string; verifyUrl: string };
  limits: { loginPerIp: number; throttlePerIp: number; throttlePerSession: number };
};

// PGPASSWORD / PGPASSFILE : lus implicitement par la bibliothèque pg, ils contourneraient les fichiers *_FILE.
const FORBIDDEN_DIRECT_SECRETS = ['DB_PASSWORD', 'DATABASE_URL', 'PGPASSWORD', 'PGPASSFILE'] as const;

/** Clé HMAC des seaux de limitation : 32 caractères au moins (§ 2.2). */
const MIN_HMAC_KEY_LENGTH = 32;

function checkForbidden(env: NodeJS.ProcessEnv): void {
  for (const key of FORBIDDEN_DIRECT_SECRETS) {
    if (env[key] !== undefined) throw new Error(`${key} must not be set: use a *_FILE secret`);
  }
}

/** Noms des variables en erreur, jamais leurs valeurs. */
function issuesOf(error: { issues: { path: PropertyKey[] }[] }): string {
  return error.issues.map((i) => i.path.map(String).join('.')).join(', ');
}

/** Configuration de la base seule : utilisée par la CLI Prisma (prisma.config.ts) et par loadConfig. */
export function loadDbConfig(env: NodeJS.ProcessEnv): DbConfig {
  checkForbidden(env);
  const parsed = dbEnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${issuesOf(parsed.error)}`);
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
  return { host: e.DB_HOST, port: e.DB_PORT, database: e.DB_NAME, user: e.DB_USER, auth };
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  checkForbidden(env);
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${issuesOf(parsed.error)}`);
  const e = parsed.data;
  const db = loadDbConfig(env);
  const rateLimitHmacKey = readSecretFile(e.RATE_LIMIT_HMAC_KEY_FILE);
  if (rateLimitHmacKey.length < MIN_HMAC_KEY_LENGTH) {
    throw new Error(`invalid configuration: RATE_LIMIT_HMAC_KEY (${MIN_HMAC_KEY_LENGTH} characters minimum)`);
  }
  return {
    nodeEnv: e.NODE_ENV,
    httpPort: e.HTTP_PORT,
    readyPort: e.READY_PORT,
    readyHost: e.READY_HOST,
    db,
    http: { origin: new URL(e.APP_ORIGIN).origin, trustProxy: e.TRUST_PROXY, logLevel: e.LOG_LEVEL },
    security: { rateLimitHmacKey },
    turnstile: { secret: readSecretFile(e.TURNSTILE_SECRET_FILE), verifyUrl: e.TURNSTILE_VERIFY_URL },
    limits: { loginPerIp: e.LOGIN_LIMIT_PER_IP, throttlePerIp: e.THROTTLE_PER_IP, throttlePerSession: e.THROTTLE_PER_SESSION },
  };
}
