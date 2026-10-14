import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { AuditRepository } from '../../src/modules/audit/audit.repository.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { SessionsRepository } from '../../src/modules/auth/sessions.repository.js';
import { SessionsService } from '../../src/modules/auth/sessions.service.js';
import { ChallengesRepository } from '../../src/modules/auth/second-factor/challenges.repository.js';
import type { AnonymousActor } from '../../src/modules/authz/actor.js';
import { AuthzService } from '../../src/modules/authz/authz.service.js';
import { CommonPasswords } from '../../src/modules/users/common-passwords.js';
import { PasswordHasher } from '../../src/modules/users/password-hasher.js';
import { UsersRepository } from '../../src/modules/users/users.repository.js';
import { UsersService } from '../../src/modules/users/users.service.js';
import { connectAs, createTestDatabase, dbConfigFor } from '../support/pg.js';

let db: string;
let prisma: PrismaService;
let sessions: SessionsService;
const ctx = { ip: '203.0.113.5', userAgent: 'vitest' };
const anon: AnonymousActor = { kind: 'anonymous', ip: ctx.ip };

beforeAll(async () => {
  db = await createTestDatabase();
  prisma = new PrismaService(dbConfigFor('cp_app', db));
  const authz = new AuthzService();
  const audit = new AuditService(new AuditRepository());
  const users = new UsersService(new UsersRepository(prisma), authz, audit, new PasswordHasher(), new CommonPasswords([]), prisma);
  sessions = new SessionsService(new SessionsRepository(prisma), users, authz, audit, prisma, new ChallengesRepository(prisma));
});
afterAll(async () => { await prisma.onModuleDestroy(); });

async function newUser(): Promise<string> {
  const id = uuidv7();
  const c = await connectAs('cp_app', db);
  await c.query(`insert into app.users (id, email, first_name, last_name, password_hash) values ($1, $2, 'Awa', 'Diop', 'x')`, [id, `${id}@example.com`]);
  await c.end();
  return id;
}
const open = (userId: string) => prisma.withTx((tx) => sessions.openInTx(tx, anon, { id: userId, globalRole: 'USER' }, ctx));
async function asOwner(sql: string, params: unknown[]) {
  const c = await connectAs('cp_owner', db);
  try { await c.query(sql, params); } finally { await c.end(); }
}

describe('SessionsService (§ 3.4)', () => {
  it('ouvre une session de 30 jours et l’authentifie', async () => {
    const u = await newUser();
    const s = await open(u);
    expect(s.maxAgeSeconds).toBe(2_592_000);
    await expect(sessions.authenticate(s.token)).resolves.toEqual({ kind: 'user', userId: u, globalRole: 'USER', sessionId: s.actor.sessionId });
    const c = await connectAs('cp_app', db);
    const r = await c.query(`select absolute_expires_at - created_at as life, idle_expires_at = absolute_expires_at as same, token_hash from app.sessions where id = $1`, [s.actor.sessionId]);
    await c.end();
    expect(r.rows[0]).toMatchObject({ same: true });
    expect(r.rows[0].life.days).toBe(30);
    expect(r.rows[0].token_hash).toEqual(createHash('sha256').update(Buffer.from(s.token, 'base64url')).digest());
  });
  it('openInTx refuse un acteur que la matrice n’autorise pas', async () => {
    const u = await newUser();
    await expect(prisma.withTx((tx) => sessions.openInTx(tx, { kind: 'cli', command: 'create-class' } as unknown as AnonymousActor, { id: u, globalRole: 'USER' }, ctx))).rejects.toThrow();
  });
  it('session révoquée, expirée, ou compte suspendu → null', async () => {
    const u = await newUser();
    const a = await open(u);
    await sessions.logout(a.actor);
    await expect(sessions.authenticate(a.token)).resolves.toBeNull();

    const b = await open(u);
    await asOwner(`update app.sessions set idle_expires_at = clock_timestamp() - interval '1 second' where id = $1`, [b.actor.sessionId]);
    await expect(sessions.authenticate(b.token)).resolves.toBeNull();

    const c = await open(u);
    await asOwner(`update app.users set status = 'SUSPENDED' where id = $1`, [u]);
    await expect(sessions.authenticate(c.token)).resolves.toBeNull();
  });
  it('last_seen_at n’est mis à jour qu’après 5 min', async () => {
    const u = await newUser();
    const s = await open(u);
    const read = async () => {
      const c = await connectAs('cp_app', db);
      const r = await c.query(`select last_seen_at from app.sessions where id = $1`, [s.actor.sessionId]);
      await c.end();
      return (r.rows[0].last_seen_at as Date).getTime();
    };
    const t0 = await read();
    await sessions.authenticate(s.token);
    expect(await read()).toBe(t0);
    await asOwner(`update app.sessions set last_seen_at = clock_timestamp() - interval '6 minutes' where id = $1`, [s.actor.sessionId]);
    const old = await read();
    await sessions.authenticate(s.token);
    expect(await read()).toBeGreaterThan(old);
  });
  it('revokeOthers garde la session courante, révoque les autres et journalise', async () => {
    const u = await newUser();
    const keep = await open(u);
    const other1 = await open(u);
    const other2 = await open(u);
    await expect(sessions.revokeOthers(keep.actor)).resolves.toBe(2);
    await expect(sessions.authenticate(keep.token)).resolves.not.toBeNull();
    await expect(sessions.authenticate(other1.token)).resolves.toBeNull();
    await expect(sessions.authenticate(other2.token)).resolves.toBeNull();
    const list = await sessions.list(keep.actor);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: keep.actor.sessionId, current: true, userAgent: 'vitest' });
    const c = await connectAs('cp_app', db);
    const r = await c.query(`select metadata from app.audit_log where action = 'SESSIONS_REVOKED' and target_id = $1`, [u]);
    await c.end();
    expect(r.rows).toEqual([{ metadata: { reason: 'OTHER_DEVICES', count: 2 } }]);
  });
});
