import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toPgPoolConfig, toPrismaCliUrl } from './database-connection.js';

const db = { host: 'db', port: 5432, database: 'classepulse', user: 'cp_owner' };

describe('options de connexion', () => {
  it('mode mot de passe : options pg sans URL', () => {
    const cfg = toPgPoolConfig({ ...db, auth: { mode: 'password', password: 'p@ss/w:rd' } });
    expect(cfg).toMatchObject({ host: 'db', port: 5432, database: 'classepulse', user: 'cp_owner', password: 'p@ss/w:rd' });
    expect(cfg.ssl).toBeUndefined();
  });
  it('délai de connexion de 2 s (une base injoignable ne bloque pas la sonde de disponibilité)', () => {
    expect(toPgPoolConfig({ ...db, auth: { mode: 'password', password: 'x' } }).connectionTimeoutMillis).toBe(2_000);
    const dir = mkdtempSync(join(tmpdir(), 'cp-conn-'));
    const f = (name: string) => { const p = join(dir, name); writeFileSync(p, name); return p; };
    const cert = toPgPoolConfig({ ...db, auth: { mode: 'cert', caFile: f('ca'), certFile: f('crt'), keyFile: f('key') } });
    expect(cert.connectionTimeoutMillis).toBe(2_000);
  });
  it('mode mot de passe : URL Prisma avec le mot de passe encodé et le schéma app', () => {
    const url = toPrismaCliUrl({ ...db, auth: { mode: 'password', password: 'p@ss/w:rd' } });
    expect(url).toBe('postgresql://cp_owner:p%40ss%2Fw%3Ard@db:5432/classepulse?schema=app');
  });
  it('mode cert : URL Prisma stricte (sslaccept=strict obligatoire)', () => {
    const url = toPrismaCliUrl({
      ...db,
      auth: { mode: 'cert', caFile: '/s/ca.crt', certFile: '/s/c.crt', keyFile: '/s/c.key', p12File: '/s/c.p12', p12Password: 'x y' },
    });
    const u = new URL(url);
    expect(u.username).toBe('cp_owner');
    expect(u.password).toBe('');
    expect(u.searchParams.get('sslmode')).toBe('require');
    expect(u.searchParams.get('sslaccept')).toBe('strict');
    expect(u.searchParams.get('sslcert')).toBe('/s/ca.crt');
    expect(u.searchParams.get('sslidentity')).toBe('/s/c.p12');
    expect(u.searchParams.get('sslpassword')).toBe('x y');
  });
  it('mode cert sans identité PKCS#12 : URL Prisma refusée', () => {
    expect(() => toPrismaCliUrl({ ...db, auth: { mode: 'cert', caFile: 'a', certFile: 'b', keyFile: 'c' } })).toThrow(/DB_SSL_P12_FILE/);
  });
});
