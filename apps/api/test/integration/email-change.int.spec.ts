import 'reflect-metadata';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { ageChallenges, createAdmin, latestCode, loginAdmin } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
beforeAll(async () => { db = await createTestDatabase(); t = await buildTestApp(db); });
afterAll(async () => { await t.close(); });

async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const emailOf = async (id: string) => (await rows('select email::text as e from app.users where id = $1', [id]))[0].e as string;
const newAddress = () => `nouveau.${uuidv7()}@example.com`;
type Ctx = Awaited<ReturnType<typeof loginAdmin>>;

async function startChange(s: Ctx, newEmail: string) {
  await ageChallenges(db, s.admin.id, 2);
  return send(t.app, 'POST', '/api/me/email-change', { password: s.admin.password, newEmail }, s.headers);
}
async function toNewStep(s: Ctx, newEmail: string) {
  expect((await startChange(s, newEmail)).statusCode).toBe(202);
  const old = await send(t.app, 'POST', '/api/me/email-change/verify-old', { code: await latestCode(db, s.admin.email, 'ADMIN_EMAIL_CHANGE_OLD') }, s.headers);
  expect(old.statusCode).toBe(202);
  return latestCode(db, newEmail, 'ADMIN_EMAIL_CHANGE_NEW');
}

describe('parcours complet (§ 3.3)', () => {
  it('mot de passe + code ancienne adresse + code nouvelle adresse : l’email change, les autres sessions sont révoquées, alertes, audit, sans step_up_at', async () => {
    const other = await createAdmin(db); // destinataire d'une alerte
    const a = await loginAdmin(t.app, db);
    const second = await loginAdmin(t.app, db, a.admin); // autre appareil du même administrateur
    const target = newAddress();
    const start = await startChange(a, target);
    expect([start.statusCode, start.json()]).toEqual([202, { expiresInSeconds: 600 }]);
    const [oldMail] = await rows(`select to_address, payload from app.email_outbox where kind = 'ADMIN_EMAIL_CHANGE_OLD' and recipient_user_id = $1 order by created_at desc limit 1`, [a.admin.id]);
    expect(oldMail).toMatchObject({ to_address: a.admin.email, payload: { newEmail: target } });
    const verifiedOld = await send(t.app, 'POST', '/api/me/email-change/verify-old', { code: await latestCode(db, a.admin.email, 'ADMIN_EMAIL_CHANGE_OLD') }, a.headers);
    expect([verifiedOld.statusCode, verifiedOld.json()]).toEqual([202, { expiresInSeconds: 600 }]);
    expect((await rows(`select to_address from app.email_outbox where kind = 'ADMIN_EMAIL_CHANGE_NEW' and recipient_user_id = $1`, [a.admin.id]))[0].to_address).toBe(target);
    const done = await send(t.app, 'POST', '/api/me/email-change/verify-new', { code: await latestCode(db, target, 'ADMIN_EMAIL_CHANGE_NEW') }, a.headers);
    expect(done.statusCode).toBe(200);
    expect(done.json().email).toBe(target);
    expect(await emailOf(a.admin.id)).toBe(target);
    const sessions = await rows(`select id, revoke_reason::text as r from app.sessions where user_id = $1 order by created_at`, [a.admin.id]);
    expect(sessions.map((s) => s.r)).toEqual([null, 'EMAIL_CHANGED']); // la session courante vit, l'autre est révoquée
    expect((await send(t.app, 'GET', '/api/me', undefined, second.headers)).statusCode).toBe(401);
    expect((await send(t.app, 'GET', '/api/me', undefined, a.headers)).statusCode).toBe(200);
    expect((await rows(`select metadata from app.audit_log where target_id = $1 and action = 'ADMIN_EMAIL_CHANGED'`, [a.admin.id]))[0].metadata).toEqual({ revokedSessions: 1 });
    expect((await rows(`select 1 from app.email_outbox where kind = 'SECURITY_ALERT' and to_address = $1 and payload->>'event' = 'EMAIL_CHANGED'`, [a.admin.email])).length).toBe(1);
    const alerts = await rows(`select recipient_user_id from app.email_outbox where kind = 'ADMIN_SECURITY_ALERT' and payload->>'event' = 'EMAIL_CHANGED' and payload->>'accountEmail' = $1`, [target]);
    expect(alerts.map((r) => r.recipient_user_id)).toContain(other.id);
    expect(alerts.map((r) => r.recipient_user_id)).not.toContain(a.admin.id);
    expect((await rows(`select step_up_at is null as n from app.sessions where id = (select id from app.sessions where user_id = $1 and revoked_at is null)`, [a.admin.id]))[0].n).toBe(true);
    await ageChallenges(db, a.admin.id, 2); // limite d'une demande de code par minute
    // la nouvelle adresse se connecte, l'ancienne non
    expect((await send(t.app, 'POST', '/api/auth/login', { email: target, password: a.admin.password })).statusCode).toBe(202);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: a.admin.email, password: a.admin.password })).statusCode).toBe(401);
  });
});

describe('jetons de réinitialisation en attente', () => {
  it('l’aboutissement du changement d’adresse annule un jeton de réinitialisation demandé pour l’ancienne adresse', async () => {
    const a = await loginAdmin(t.app, db);
    expect((await send(t.app, 'POST', '/api/auth/forgot-password', { email: a.admin.email, turnstileToken: 'tok' })).statusCode).toBe(202);
    const pending = async () => (await rows(`select count(*)::int as n from app.password_reset_tokens where user_id = $1 and consumed_at is null`, [a.admin.id]))[0].n as number;
    expect(await pending()).toBe(1);
    const target = newAddress();
    const code = await toNewStep(a, target);
    expect(await pending()).toBe(1); // pas avant l'aboutissement
    expect((await send(t.app, 'POST', '/api/me/email-change/verify-new', { code }, a.headers)).statusCode).toBe(200);
    expect(await pending()).toBe(0);
  });
});

describe('début du parcours', () => {
  it('mot de passe faux, même adresse, adresse déjà prise : aucune vérification, aucune session révoquée (Review Focus 6)', async () => {
    const taken = await createAdmin(db);
    const a = await loginAdmin(t.app, db);
    await ageChallenges(db, a.admin.id, 2);
    const bad = await send(t.app, 'POST', '/api/me/email-change', { password: 'un mauvais mot de passe long', newEmail: newAddress() }, a.headers);
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'CURRENT_PASSWORD_INVALID']);
    const same = await send(t.app, 'POST', '/api/me/email-change', { password: a.admin.password, newEmail: a.admin.email.toUpperCase() }, a.headers);
    expect([same.statusCode, same.json().error.code]).toEqual([400, 'EMAIL_UNCHANGED']);
    const dup = await send(t.app, 'POST', '/api/me/email-change', { password: a.admin.password, newEmail: taken.email }, a.headers);
    expect([dup.statusCode, dup.json().error.code]).toEqual([409, 'EMAIL_TAKEN']);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose in ('EMAIL_CHANGE_OLD', 'EMAIL_CHANGE_NEW')`, [a.admin.id])).toHaveLength(0);
    expect((await rows(`select count(*)::int as n from app.sessions where user_id = $1 and revoked_at is null`, [a.admin.id]))[0].n).toBe(1);
  });
  it('un étudiant : 403 ; un administrateur sans parcours en cours : CHALLENGE_EXPIRED aux deux étapes', async () => {
    const classId = await insertClass(db, 'L3 EmailChange');
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'POST', '/api/me/email-change', { password: s.password, newEmail: newAddress() }, { cookie: `__Host-cp_session=${s.token}` });
    expect(res.statusCode).toBe(403);
    const a = await loginAdmin(t.app, db);
    for (const step of ['verify-old', 'verify-new']) {
      const r = await send(t.app, 'POST', `/api/me/email-change/${step}`, { code: '123456' }, a.headers);
      expect([r.statusCode, r.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    }
  });
  it('deux demandes simultanées : une seule aboutit', async () => {
    const a = await loginAdmin(t.app, db);
    await ageChallenges(db, a.admin.id, 2);
    const body = { password: a.admin.password, newEmail: newAddress() };
    const res = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/me/email-change', body, a.headers)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([202, 429]);
  });
});

describe('codes et liaison à la session', () => {
  it('mauvais code à l’ancienne adresse : CODE_INVALID ; le code de la nouvelle adresse ne sert pas à l’étape 1', async () => {
    const a = await loginAdmin(t.app, db);
    expect((await startChange(a, newAddress())).statusCode).toBe(202);
    const code = await latestCode(db, a.admin.email, 'ADMIN_EMAIL_CHANGE_OLD');
    const bad = await send(t.app, 'POST', '/api/me/email-change/verify-old', { code: code === '000000' ? '000001' : '000000' }, a.headers);
    expect([bad.statusCode, bad.json().error.code, bad.json().error.attemptsLeft]).toEqual([400, 'CODE_INVALID', 4]);
    expect((await send(t.app, 'POST', '/api/me/email-change/verify-new', { code }, a.headers)).json().error.code).toBe('CHALLENGE_EXPIRED'); // pas encore de vérification NEW
  });
  it('le code d’une autre session du même administrateur ne sert pas, et ne la consomme pas', async () => {
    const a = await loginAdmin(t.app, db);
    const b = await loginAdmin(t.app, db, a.admin);
    expect((await startChange(a, newAddress())).statusCode).toBe(202);
    const code = await latestCode(db, a.admin.email, 'ADMIN_EMAIL_CHANGE_OLD');
    expect((await send(t.app, 'POST', '/api/me/email-change/verify-old', { code }, b.headers)).json().error.code).toBe('CHALLENGE_EXPIRED');
    expect((await send(t.app, 'POST', '/api/me/email-change/verify-old', { code }, a.headers)).statusCode).toBe(202);
  });
});

describe('fin du parcours : verrous et conflits', () => {
  it('adresse prise entre les deux étapes : 409 EMAIL_TAKEN, l’email ne change pas, aucune session révoquée, la vérification reste', async () => {
    const a = await loginAdmin(t.app, db);
    await loginAdmin(t.app, db, a.admin);
    const target = newAddress();
    const codeNew = await toNewStep(a, target);
    await createAdmin(db, { email: target }); // quelqu'un prend l'adresse entre-temps
    const res = await send(t.app, 'POST', '/api/me/email-change/verify-new', { code: codeNew }, a.headers);
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'EMAIL_TAKEN']);
    expect(await emailOf(a.admin.id)).toBe(a.admin.email);
    expect((await rows(`select count(*)::int as n from app.sessions where user_id = $1 and revoked_at is null`, [a.admin.id]))[0].n).toBe(2);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose = 'EMAIL_CHANGE_NEW' and consumed_at is null`, [a.admin.id])).toHaveLength(1);
  });
  it('session révoquée entre verify-old et verify-new, pendant que la requête attend le verrou de la session : CHALLENGE_EXPIRED, l’email ne change pas', async () => {
    const a = await loginAdmin(t.app, db);
    const target = newAddress();
    const codeNew = await toNewStep(a, target);
    const sid = (await rows(`select id from app.sessions where user_id = $1 and revoked_at is null`, [a.admin.id]))[0].id as string;
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.sessions where id = $1 for update', [sid]);
    const pending = send(t.app, 'POST', '/api/me/email-change/verify-new', { code: codeNew }, a.headers);
    await waitForLockWait(db, pid);
    await holder.query(`update app.sessions set revoked_at = clock_timestamp(), revoke_reason = 'ADMIN_REVOKED' where id = $1`, [sid]);
    await holder.query('commit');
    await holder.end();
    const res = await pending;
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect(await emailOf(a.admin.id)).toBe(a.admin.email);
  });
  it('deux validations simultanées de la nouvelle adresse : un seul changement, un seul audit', async () => {
    const a = await loginAdmin(t.app, db);
    const target = newAddress();
    const codeNew = await toNewStep(a, target);
    const res = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/me/email-change/verify-new', { code: codeNew }, a.headers)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await rows(`select 1 from app.audit_log where target_id = $1 and action = 'ADMIN_EMAIL_CHANGED'`, [a.admin.id])).toHaveLength(1);
    expect(await emailOf(a.admin.id)).toBe(target);
  });
});

describe('révocation, vérifications liées et plafond vers la nouvelle adresse (amendements D2, D10, R21)', () => {
  it('D2 : une vérification STEP_UP liée à une autre session révoquée est consommée SESSION_ENDED dans la même transaction', async () => {
    const a = await loginAdmin(t.app, db);
    const b = await loginAdmin(t.app, db, a.admin);
    await ageChallenges(db, a.admin.id, 2);
    expect((await send(t.app, 'POST', '/api/me/step-up', { password: a.admin.password }, b.headers)).statusCode).toBe(202);
    const codeNew = await toNewStep(a, newAddress());
    expect((await send(t.app, 'POST', '/api/me/email-change/verify-new', { code: codeNew }, a.headers)).statusCode).toBe(200);
    const left = await rows(`select consumed_reason::text as r from app.auth_challenges where user_id = $1 and purpose = 'STEP_UP'`, [a.admin.id]);
    expect(left.map((r) => r.r)).toEqual(['SESSION_ENDED']);
  });
  it('D10 : une nouvelle demande annule la vérification en attente vers l’ancienne cible (le code précédent ne sert plus)', async () => {
    const a = await loginAdmin(t.app, db);
    const first = await toNewStep(a, newAddress());
    expect((await startChange(a, newAddress())).statusCode).toBe(202);
    expect((await send(t.app, 'POST', '/api/me/email-change/verify-new', { code: first }, a.headers)).json().error.code).toBe('CHALLENGE_EXPIRED');
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose = 'EMAIL_CHANGE_NEW' and consumed_reason = 'SUPERSEDED'`, [a.admin.id])).toHaveLength(1);
  });
  it('R21 : l’adresse choisie par le demandeur reçoit au plus un code par vérification de l’ancienne adresse (5 demandes par heure, connexion comprise)', async () => {
    const a = await loginAdmin(t.app, db);
    const third = newAddress();
    for (let i = 0; i < 4; i++) await toNewStep(a, third); // la connexion compte pour la 5e demande de l’heure
    await ageChallenges(db, a.admin.id, 2);
    const sixth = await send(t.app, 'POST', '/api/me/email-change', { password: a.admin.password, newEmail: third }, a.headers);
    expect(sixth.statusCode).toBe(429);
    expect(await rows(`select 1 from app.email_outbox where kind = 'ADMIN_EMAIL_CHANGE_NEW' and to_address = $1`, [third])).toHaveLength(4);
  });
});
