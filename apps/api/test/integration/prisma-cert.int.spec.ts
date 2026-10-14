import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestPki } from '../support/certs.js';
import { PG_IMAGE } from '../support/images.js';
import { makeScratchPrismaProject, runPrisma } from '../support/prisma-cli.js';

let c: StartedPostgreSqlContainer;
let pki: ReturnType<typeof makeTestPki>;
// Mot de passe PKCS#12 aléatoire : sa valeur ne doit apparaître dans aucune sortie de la CLI.
const P12_PASSWORD = `p12_${randomBytes(12).toString('hex')}`;

beforeAll(async () => {
  pki = makeTestPki('localhost');
  const hba = join(pki.dir, 'pg_hba.conf');
  writeFileSync(hba, [
    'local all postgres peer',
    'local all all reject',
    'hostssl classepulse cp_owner 0.0.0.0/0 cert map=cp',
    'host all postgres 0.0.0.0/0 scram-sha-256',
    'host all all 0.0.0.0/0 reject',
  ].join('\n') + '\n');
  const ident = join(pki.dir, 'pg_ident.conf');
  writeFileSync(ident, 'cp cp_owner cp_owner\n');
  c = await new PostgreSqlContainer(PG_IMAGE)
    .withUsername('postgres').withPassword('super-test').withDatabase('postgres')
    .withCopyFilesToContainer([
      { source: pki.caCrt, target: '/etc/pgssl/ca.crt', mode: 0o644 },
      { source: pki.serverCrt, target: '/etc/pgssl/server.crt', mode: 0o644 },
      { source: pki.serverKey, target: '/etc/pgssl/server.key', mode: 0o600 },
      { source: hba, target: '/etc/pgssl/pg_hba.conf', mode: 0o644 },
      { source: ident, target: '/etc/pgssl/pg_ident.conf', mode: 0o644 },
    ])
    .withCopyDirectoriesToContainer([{ source: resolve(import.meta.dirname, '../../../../db'), target: '/bootstrap' }])
    .withCommand(['sh', '-c', 'chown postgres /etc/pgssl/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/pgssl/server.crt -c ssl_key_file=/etc/pgssl/server.key -c ssl_ca_file=/etc/pgssl/ca.crt -c hba_file=/etc/pgssl/pg_hba.conf -c ident_file=/etc/pgssl/pg_ident.conf'])
    .start();
  for (const args of [
    ['-d', 'postgres', '-f', '/bootstrap/db-bootstrap-cluster.sql'],
    ['-d', 'postgres', '-v', 'dbname=classepulse', '-f', '/bootstrap/db-bootstrap-database.sql'],
  ]) {
    const r = await c.exec(['psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', ...args], { user: 'postgres' });
    if (r.exitCode !== 0) throw new Error(r.output);
  }
});
afterAll(async () => { await c?.stop(); });

function ownerDb(caFile: string) {
  const id = pki.clientFor('cp_owner', P12_PASSWORD);
  return { host: c.getHost(), port: c.getPort(), database: 'classepulse', user: 'cp_owner',
    auth: { mode: 'cert' as const, caFile, certFile: id.crt, keyFile: id.key, p12File: id.p12, p12Password: id.password } };
}

describe('T-01 partie C — certificat client avec Prisma 7.10.0', () => {
  it('cp_owner n’a aucun mot de passe', async () => {
    const r = await c.exec(['psql', '-U', 'postgres', '-tAc', "select rolpassword is null from pg_authid where rolname = 'cp_owner'"], { user: 'postgres' });
    expect(r.output.trim()).toBe('t');
  });

  it('migrate deploy réussit avec sslidentity + sslaccept=strict', async () => {
    const cfg = makeScratchPrismaProject({ '20990101000000_c': '-- classification: expand\nBEGIN;\nCREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE app.c_ok (id int);\nCOMMIT;\n' });
    const r = await runPrisma(['migrate', 'deploy'], ownerDb(pki.caCrt), { configPath: cfg });
    expect(r.stderr + r.stdout).not.toMatch(/sslaccept|sslpassword/i);
    expect(r.stderr + r.stdout).not.toContain(P12_PASSWORD);
    expect(r.code).toBe(0);
    const e = await c.exec(['psql', '-U', 'postgres', '-d', 'classepulse', '-tAc', "select to_regclass('app.c_ok') is not null"], { user: 'postgres' });
    expect(e.output.trim()).toBe('t');
  });

  it('migrate deploy échoue si le serveur n’est pas signé par l’autorité attendue', async () => {
    const cfg = makeScratchPrismaProject({ '20990101000001_c2': '-- classification: expand\nBEGIN;\nCREATE TABLE app.c_ko (id int);\nCOMMIT;\n' });
    const r = await runPrisma(['migrate', 'deploy'], ownerDb(pki.foreignCa()), { configPath: cfg });
    expect(r.code).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/P1011|certificate|TLS|self.signed|unknown ca|certificat/i);
    expect(out).not.toMatch(/invalid configuration/i);
    expect(out).not.toContain(P12_PASSWORD);
  });
});
