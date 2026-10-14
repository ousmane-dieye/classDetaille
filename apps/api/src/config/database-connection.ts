import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';
import type { DbConfig } from './load-config.js';

export function toPgPoolConfig(db: DbConfig): PoolConfig {
  // connectionTimeoutMillis : une base injoignable ne bloque ni les requêtes ni la sonde de disponibilité.
  const base: PoolConfig = { host: db.host, port: db.port, database: db.database, user: db.user, connectionTimeoutMillis: 2_000 };
  if (db.auth.mode === 'password') return { ...base, password: db.auth.password };
  return {
    ...base,
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(db.auth.caFile, 'utf8'),
      cert: readFileSync(db.auth.certFile, 'utf8'),
      key: readFileSync(db.auth.keyFile, 'utf8'),
    },
  };
}

export function toPrismaCliUrl(db: DbConfig): string {
  const u = new URL(`postgresql://${db.host}:${db.port}/${encodeURIComponent(db.database)}`);
  u.username = encodeURIComponent(db.user);
  u.searchParams.set('schema', 'app');
  if (db.auth.mode === 'password') {
    u.password = encodeURIComponent(db.auth.password);
    return u.toString();
  }
  if (!db.auth.p12File) throw new Error('invalid configuration: DB_SSL_P12_FILE (required by the Prisma CLI)');
  u.searchParams.set('sslmode', 'require');
  u.searchParams.set('sslaccept', 'strict');
  u.searchParams.set('sslcert', db.auth.caFile);
  u.searchParams.set('sslidentity', db.auth.p12File);
  if (db.auth.p12Password !== undefined) u.searchParams.set('sslpassword', db.auth.p12Password);
  return u.toString();
}
