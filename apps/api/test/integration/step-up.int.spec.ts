import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { StepUpService } from '../../src/modules/auth/step-up.service.js';
import { PASSWORD, buildTestApp, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { ageChallenges, loginAdmin, latestCode } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let svc: StepUpService;
let prisma: PrismaService;
beforeAll(async () => {
  db = await createTestDatabase();
  t = await buildTestApp(db);
  svc = t.app.get(StepUpService, { strict: false });
  prisma = t.app.get(PrismaService, { strict: false });
});
afterAll(async () => { await t.close(); });

async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const setSession = async (userId: string, sets: string) => { const c = await connectAs('cp_app', db); await c.query(`update app.sessions set ${sets} where user_id = $1`, [userId]); await c.end(); };
const fresh = (userId: string, sessionId: string) => prisma.withTx((tx) => svc.assertStepUpFreshInTx(tx, { kind: 'user', userId, globalRole: 'ADMIN', sessionId }));
const recent = (userId: string, sessionId: string) => prisma.withTx((tx) => svc.assertRecentPasswordInTx(tx, { kind: 'user', userId, globalRole: 'ADMIN', sessionId }));
const sessionIdOf = async (userId: string) => (await rows(`select id from app.sessions where user_id = $1 and revoked_at is null order by created_at desc limit 1`, [userId]))[0].id as string;

describe('POST /api/me/reauth', () => {
  it('mot de passe juste : 204 et reauth_at posé ; faux : 400 CURRENT_PASSWORD_INVALID ; le délai croissant du lot 1a s’applique', async () => {
    const classId = await insertClass(db, 'L3 Reauth');
    const s = await registerStudent(t.app, classId);
    const headers = { cookie: `__Host-cp_session=${s.token}` };
    const ip = '198.51.100.50';
    const bad = await send(t.app, 'POST', '/api/me/reauth', { password: 'un mauvais mot de passe long' }, headers, ip);
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'CURRENT_PASSWORD_INVALID']);
    const again = await send(t.app, 'POST', '/api/me/reauth', { password: s.password }, headers, ip);
    expect(again.statusCode).toBe(429); // R5 du lot 1a : délai croissant après un échec
    const ok = await send(t.app, 'POST', '/api/me/reauth', { password: s.password }, headers);
    expect(ok.statusCode).toBe(204);
    expect((await rows(`select reauth_at is not null as r from app.sessions where user_id = $1`, [s.userId]))[0].r).toBe(true);
  });
  it('sans session : 401', async () => {
    expect((await send(t.app, 'POST', '/api/me/reauth', { password: PASSWORD })).statusCode).toBe(401);
  });
});

describe('étapes de la vérification supplémentaire', () => {
  it('un étudiant ne la demande pas (403 FORBIDDEN)', async () => {
    const classId = await insertClass(db, 'L3 StepUp Student');
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'POST', '/api/me/step-up', { password: s.password }, { cookie: `__Host-cp_session=${s.token}` });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'FORBIDDEN']);
  });
  it('mot de passe faux : 400, aucune vérification, aucun email', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    await ageChallenges(db, admin.id, 2);
    const res = await send(t.app, 'POST', '/api/me/step-up', { password: 'un mauvais mot de passe long' }, headers);
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CURRENT_PASSWORD_INVALID']);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose = 'STEP_UP'`, [admin.id])).toHaveLength(0);
  });
  it('parcours complet : mot de passe, code lié à la session, puis step_up_at', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    await ageChallenges(db, admin.id, 2);
    const start = await send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, headers);
    expect([start.statusCode, start.json()]).toEqual([202, { expiresInSeconds: 600 }]);
    const [ch] = await rows(`select session_id, token_hash, purpose::text as p from app.auth_challenges where user_id = $1 and purpose = 'STEP_UP' and consumed_at is null`, [admin.id]);
    expect(ch).toMatchObject({ p: 'STEP_UP', token_hash: null, session_id: await sessionIdOf(admin.id) });
    expect((await rows(`select payload from app.email_outbox where kind = 'ADMIN_OTP' and recipient_user_id = $1 order by created_at desc limit 1`, [admin.id]))[0].payload).toEqual({ purpose: 'STEP_UP' });
    const code = await latestCode(db, admin.email);
    const done = await send(t.app, 'POST', '/api/me/step-up/verify', { code }, headers);
    expect(done.statusCode).toBe(204);
    const [s] = await rows(`select step_up_at is not null as su, reauth_at is not null as re from app.sessions where user_id = $1`, [admin.id]);
    expect(s).toEqual({ su: true, re: true });
    expect((await rows(`select consumed_reason::text as r from app.auth_challenges where user_id = $1 and purpose = 'STEP_UP'`, [admin.id]))[0].r).toBe('USED');
    await fresh(admin.id, await sessionIdOf(admin.id)); // ne lève pas
  });
  it('mauvais code : CODE_INVALID, essais comptés ; sans demande préalable : CHALLENGE_EXPIRED', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    const none = await send(t.app, 'POST', '/api/me/step-up/verify', { code: '123456' }, headers);
    expect([none.statusCode, none.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    await ageChallenges(db, admin.id, 2);
    await send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, headers);
    const code = await latestCode(db, admin.email);
    const bad = await send(t.app, 'POST', '/api/me/step-up/verify', { code: code === '000000' ? '000001' : '000000' }, headers);
    expect([bad.statusCode, bad.json().error.code, bad.json().error.attemptsLeft]).toEqual([400, 'CODE_INVALID', 4]);
    expect(bad.headers['set-cookie']).toBeUndefined(); // aucun cookie de vérification dans ce parcours
  });
  it('le code d’une autre session du même administrateur ne sert pas, et ne la consomme pas', async () => {
    const a = await loginAdmin(t.app, db);
    await ageChallenges(db, a.admin.id, 2);
    const b = await loginAdmin(t.app, db, a.admin);
    await ageChallenges(db, a.admin.id, 2);
    await send(t.app, 'POST', '/api/me/step-up', { password: a.admin.password }, a.headers);
    const code = await latestCode(db, a.admin.email);
    const wrongSession = await send(t.app, 'POST', '/api/me/step-up/verify', { code }, b.headers);
    expect([wrongSession.statusCode, wrongSession.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect((await send(t.app, 'POST', '/api/me/step-up/verify', { code }, a.headers)).statusCode).toBe(204);
  });
  it('deux demandes simultanées : une seule aboutit ; deux validations simultanées : une seule réussit', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    await ageChallenges(db, admin.id, 2);
    const starts = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, headers)));
    expect(starts.map((r) => r.statusCode).sort()).toEqual([202, 429]);
    const code = await latestCode(db, admin.email);
    const verifies = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/me/step-up/verify', { code }, headers)));
    expect(verifies.map((r) => r.statusCode).sort()).toEqual([204, 400]);
  });
  it('validation en attente du verrou de l’administrateur puis consommation par le titulaire : CHALLENGE_EXPIRED (verrou observé)', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    await ageChallenges(db, admin.id, 2);
    await send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, headers);
    const code = await latestCode(db, admin.email);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [admin.id]);
    await holder.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where user_id = $1 and purpose = 'STEP_UP'`, [admin.id]);
    const pending = send(t.app, 'POST', '/api/me/step-up/verify', { code }, headers);
    await waitForLockWait(db, pid);
    await holder.query('commit');
    await holder.end();
    expect((await pending).json().error.code).toBe('CHALLENGE_EXPIRED');
  });
});

describe('gardes de fraîcheur (consommés par le lot 2, dans la transaction de l’action)', () => {
  it('assertStepUpFreshInTx : PASSWORD manquant, puis CODE manquant, puis valide ; moins de 5 minutes pour chacun', async () => {
    const { admin } = await loginAdmin(t.app, db);
    const sid = await sessionIdOf(admin.id);
    await expect(fresh(admin.id, sid)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', extra: { missing: 'PASSWORD' } });
    await setSession(admin.id, `reauth_at = clock_timestamp()`);
    await expect(fresh(admin.id, sid)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', extra: { missing: 'CODE' } });
    await setSession(admin.id, `step_up_at = clock_timestamp()`);
    await fresh(admin.id, sid);
    await setSession(admin.id, `step_up_at = clock_timestamp() - interval '4 minutes 59 seconds'`);
    await fresh(admin.id, sid);
    await setSession(admin.id, `step_up_at = clock_timestamp() - interval '5 minutes 1 second'`);
    await expect(fresh(admin.id, sid)).rejects.toMatchObject({ extra: { missing: 'CODE' } });
    await setSession(admin.id, `step_up_at = clock_timestamp(), reauth_at = clock_timestamp() - interval '5 minutes 1 second'`);
    await expect(fresh(admin.id, sid)).rejects.toMatchObject({ extra: { missing: 'PASSWORD' } });
  });
  it('assertRecentPasswordInTx : REAUTH_REQUIRED sans ressaisie récente', async () => {
    const { admin } = await loginAdmin(t.app, db);
    const sid = await sessionIdOf(admin.id);
    await expect(recent(admin.id, sid)).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    await setSession(admin.id, `reauth_at = clock_timestamp() - interval '4 minutes'`);
    await recent(admin.id, sid);
    await setSession(admin.id, `reauth_at = clock_timestamp() - interval '6 minutes'`);
    await expect(recent(admin.id, sid)).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
  });
  it('une session révoquée : 401, jamais une fraîcheur', async () => {
    const { admin } = await loginAdmin(t.app, db);
    const sid = await sessionIdOf(admin.id);
    await setSession(admin.id, `reauth_at = clock_timestamp(), step_up_at = clock_timestamp(), revoked_at = clock_timestamp(), revoke_reason = 'ADMIN_REVOKED'`);
    await expect(fresh(admin.id, sid)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('un acteur non administrateur est refusé par la matrice', async () => {
    await expect(prisma.withTx((tx) => svc.assertStepUpFreshInTx(tx, { kind: 'user', userId: 'x', globalRole: 'USER', sessionId: 'y' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('D2 : fin de session = vérifications liées consommées (SESSION_ENDED), même transaction', () => {
  async function pendingStepUp(admin: { id: string; email: string; password: string }, headers: Record<string, string>) {
    await ageChallenges(db, admin.id, 2);
    const r = await send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, headers);
    expect(r.statusCode).toBe(202);
  }
  const reasonOf = async (userId: string) => (await rows(`select consumed_reason::text as r from app.auth_challenges where user_id = $1 and purpose = 'STEP_UP' order by created_at desc limit 1`, [userId]))[0].r as string | null;
  it('logout', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    await pendingStepUp(admin, headers);
    const code = await latestCode(db, admin.email);
    expect((await send(t.app, 'POST', '/api/auth/logout', {}, headers)).statusCode).toBe(204);
    expect(await reasonOf(admin.id)).toBe('SESSION_ENDED');
    const b = await loginAdmin(t.app, db, admin);
    expect((await send(t.app, 'POST', '/api/me/step-up/verify', { code }, b.headers)).json().error.code).toBe('CHALLENGE_EXPIRED');
  });
  it('revoke-others : la vérification de la session révoquée est consommée, celle de la session conservée reste', async () => {
    const a = await loginAdmin(t.app, db);
    await pendingStepUp(a.admin, a.headers); // liée à la session a
    const b = await loginAdmin(t.app, db, a.admin);
    expect((await send(t.app, 'POST', '/api/me/sessions/revoke-others', {}, b.headers)).json()).toEqual({ revoked: 1 });
    expect(await reasonOf(a.admin.id)).toBe('SESSION_ENDED');
    await pendingStepUp(a.admin, b.headers); // liée à la session b (conservée)
    expect((await send(t.app, 'POST', '/api/me/sessions/revoke-others', {}, b.headers)).json()).toEqual({ revoked: 0 });
    expect(await reasonOf(a.admin.id)).toBeNull();
  });
  it('changement de mot de passe', async () => {
    const a = await loginAdmin(t.app, db);
    await pendingStepUp(a.admin, a.headers); // liée à la session a
    const b = await loginAdmin(t.app, db, a.admin);
    const res = await send(t.app, 'POST', '/api/me/password', { currentPassword: a.admin.password, newPassword: 'un autre mot de passe tres long 42' }, b.headers);
    expect(res.statusCode).toBe(204);
    expect(await reasonOf(a.admin.id)).toBe('SESSION_ENDED');
  });
});

describe('ordre des verrous de startStepUp (users avant sessions)', () => {
  it('en attente du verrou users, la demande ne tient pas la ligne de session', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    await ageChallenges(db, admin.id, 2);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [admin.id]);
    const pending = send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, headers);
    await waitForLockWait(db, pid);
    const third = await connectAs('cp_app', db);
    try {
      await third.query('begin');
      await third.query(`set local lock_timeout = '1s'`);
      // une écriture concurrente sur la session (comme une déconnexion) ne doit pas attendre
      await third.query(`update app.sessions set last_seen_at = clock_timestamp() where user_id = $1`, [admin.id]);
      await third.query('commit');
    } finally { await third.end(); }
    await holder.query('commit');
    await holder.end();
    expect((await pending).statusCode).toBe(202);
  });
});
