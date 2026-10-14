import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { getContainerRuntimeClient } from 'testcontainers';
import { inject } from 'vitest';
import type { DbConfig } from '../../src/config/load-config.js';

export type Role = 'postgres' | 'cp_owner' | 'cp_app' | 'cp_ops' | 'cp_monitor';

function info() { return inject('pg'); }

export async function connectAs(role: Role, database: string): Promise<pg.Client> {
  const i = info();
  const client = new pg.Client({
    host: i.host,
    port: i.port,
    user: role,
    password: role === 'postgres' ? i.superPassword : i.rolePassword,
    database,
  });
  await client.connect();
  return client;
}

export async function runSql(database: string, sql: string): Promise<void> {
  const c = await connectAs('postgres', database);
  try { await c.query(sql); } finally { await c.end(); }
}

export async function createTestDatabase(): Promise<string> {
  const i = info();
  const name = `t_${randomBytes(6).toString('hex')}`;
  await runSql('postgres', `CREATE DATABASE ${name} TEMPLATE ${i.templateDb} OWNER cp_owner`);
  await runSql('postgres', `REVOKE ALL ON DATABASE ${name} FROM PUBLIC; GRANT CONNECT ON DATABASE ${name} TO cp_owner, cp_app, cp_ops, cp_monitor`);
  return name;
}

export function dbConfigFor(role: Exclude<Role, 'postgres'>, database: string): DbConfig {
  const i = info();
  return { host: i.host, port: i.port, database, user: role, auth: { mode: 'password', password: i.rolePassword } };
}

/** Accès au conteneur (dockerode) pour lire les journaux : `(await getPgContainer()).logs({ stdout: true, stderr: true })`. */
export async function getPgContainer() {
  const client = await getContainerRuntimeClient();
  return client.container.getById(info().containerId);
}

/** Exécute une commande dans le conteneur PostgreSQL (utilisateur postgres), p. ex. psql sur un script de /bootstrap. */
export async function execInPg(command: string[]) {
  const client = await getContainerRuntimeClient();
  return client.container.exec(client.container.getById(info().containerId), command, { user: 'postgres' });
}
