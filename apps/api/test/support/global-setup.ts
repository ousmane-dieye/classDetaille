import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { PG_IMAGE } from './images.js';

export type PgInfo = { host: string; port: number; superPassword: string; rolePassword: string; templateDb: string; containerId: string };

declare module 'vitest' {
  export interface ProvidedContext { pg: PgInfo }
}

let container: StartedPostgreSqlContainer | undefined;

async function psql(c: StartedPostgreSqlContainer, args: string[]): Promise<void> {
  const r = await c.exec(['psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', ...args]);
  if (r.exitCode !== 0) throw new Error(`psql failed (${r.exitCode}): ${r.output}`);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const superPassword = randomBytes(18).toString('hex');
  const rolePassword = randomBytes(18).toString('hex');
  container = await new PostgreSqlContainer(PG_IMAGE)
    .withUsername('postgres')
    .withPassword(superPassword)
    .withDatabase('postgres')
    .withCommand(['postgres', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'log_statement=none', '-c', 'log_parameter_max_length=0', '-c', 'log_parameter_max_length_on_error=0'])
    .withCopyDirectoriesToContainer([{ source: resolve(import.meta.dirname, '../../../../db'), target: '/bootstrap' }])
    .start();

  await psql(container, ['-d', 'postgres', '-f', '/bootstrap/db-bootstrap-cluster.sql']);
  // Test uniquement : mots de passe aléatoires pour le mode « password ». Jamais en production.
  for (const role of ['cp_owner', 'cp_app', 'cp_ops', 'cp_monitor']) {
    await psql(container, ['-d', 'postgres', '-c', `ALTER ROLE ${role} PASSWORD '${rolePassword}'`]);
  }
  const templateDb = 'cp_template';
  await psql(container, ['-d', 'postgres', '-v', `dbname=${templateDb}`, '-f', '/bootstrap/db-bootstrap-database.sql']);

  project.provide('pg', {
    host: container.getHost(),
    port: container.getPort(),
    superPassword,
    rolePassword,
    templateDb,
    containerId: container.getId(),
  });
  return async () => { await container?.stop(); };
}
