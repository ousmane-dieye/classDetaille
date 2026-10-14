import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../../src/config/config.module.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import { AuthzModule } from '../../src/modules/authz/authz.module.js';
import { JobLeaseService } from '../../src/modules/jobs/job-lease.service.js';
import { JobsSupportModule } from '../../src/modules/jobs/jobs-support.module.js';
import { JobScheduler, SCHEDULER_TIMING } from '../../src/modules/jobs/job-scheduler.js';
import { EmailSender } from '../../src/modules/mail/email-sender.js';
import { MailTransport, type OutgoingMail } from '../../src/modules/mail/mail-transport.js';
import { MailWorkerModule } from '../../src/modules/mail/mail-worker.module.js';
import type { SendResult } from '../../src/modules/mail/outbox.repository.js';
import { MaintenanceModule } from '../../src/modules/maintenance/maintenance.module.js';
import { MaintenanceService } from '../../src/modules/maintenance/maintenance.service.js';
import { WorkerModule } from '../../src/worker/worker.module.js';
import { testConfig, workerConfigFor } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { SYSTEM, attemptRows, emailRow, forceEmail, seedChallengeEmail, seedPlainEmail } from '../support/mail.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

const ACCEPT: SendResult = { kind: 'ACCEPTED', smtpCode: 250, response: '250 OK', errorCode: null };
class FakeTransport extends MailTransport {
  sent: OutgoingMail[] = [];
  queue: SendResult[] = [];
  gate: Promise<void> | null = null;
  async send(m: OutgoingMail): Promise<SendResult> {
    this.sent.push(m);
    if (this.gate) await this.gate;
    return this.queue.shift() ?? ACCEPT;
  }
}

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });

async function senderModule(transport: FakeTransport) {
  const mod = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, MailWorkerModule.register(workerConfigFor(db), transport)],
  }).compile();
  await mod.init();
  return { sender: mod.get(EmailSender), close: () => mod.close() };
}
const live = () => new AbortController().signal;
const makeDue = (id: string) => forceEmail(db, id, `next_attempt_at = clock_timestamp() - interval '1 second'`);
/** Envoie tout ce qui est dû avec un transport qui accepte, pour que chaque test parte d'une file contrôlée. */
async function cleanQueue() {
  const { sender, close } = await senderModule(new FakeTransport());
  await sender.drain(SYSTEM, live());
  await close();
}
const waitUntil = async (cond: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 200; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`délai dépassé : ${what}`);
};

describe('EmailSender', () => {
  it('envoie un email de code : texte déchiffré, ACCEPTED, contenu chiffré effacé', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    const { sender, close } = await senderModule(t);
    const s = await seedChallengeEmail(db, '654321');
    await sender.drain(SYSTEM, live());
    await close();
    const mail = t.sent.find((m) => m.to === s.email)!;
    expect(mail.text).toContain('654321');
    expect(mail.subject).not.toContain('654321');
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'ACCEPTED', has_payload: false });
  });
  it('résultat ambigu puis reprise : même Message-ID, FAILED si la reprise n’est pas acceptée', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    t.queue = [{ kind: 'AMBIGUOUS', smtpCode: null, response: null, errorCode: 'ECONNRESET' }, { kind: 'TEMP_FAIL', smtpCode: 451, response: '451', errorCode: null }];
    const { sender, close } = await senderModule(t);
    const id = await seedPlainEmail(db);
    await sender.drain(SYSTEM, live());
    expect((await emailRow(db, id)).status).toBe('UNCERTAIN');
    await makeDue(id);
    await sender.drain(SYSTEM, live());
    await close();
    expect((await emailRow(db, id)).status).toBe('FAILED');
    expect((await attemptRows(db, id)).map((a) => a.outcome)).toEqual(['AMBIGUOUS', 'TEMP_FAIL']);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]!.messageId).toBe(t.sent[1]!.messageId);
  });
  it('contrôle juste avant l’envoi : une vérification déjà expirée n’envoie rien', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    const { sender, close } = await senderModule(t);
    const s = await seedChallengeEmail(db);
    const owner = await connectAs('cp_owner', db); // expires_at n'est pas modifiable par cp_app
    await owner.query(`update app.auth_challenges set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [s.challengeId]);
    await owner.end();
    await sender.drain(SYSTEM, live());
    await close();
    expect(t.sent.some((m) => m.to === s.email)).toBe(false);
    expect((await emailRow(db, s.emailId)).status).toBe('CANCELLED');
  });
  it('annulé pendant l’envoi : jamais réactivé, le résultat tardif n’écrit que son code', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    let release!: () => void;
    t.gate = new Promise<void>((r) => { release = r; });
    const { sender, close } = await senderModule(t);
    const s = await seedChallengeEmail(db);
    const draining = sender.drain(SYSTEM, live());
    await waitUntil(() => t.sent.some((m) => m.to === s.email), 'envoi commencé');
    const c = await connectAs('cp_app', db);
    await c.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [s.challengeId]);
    await c.end();
    release();
    await draining;
    await close();
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'CANCELLED', has_payload: false });
    expect((await attemptRows(db, s.emailId))[0]).toMatchObject({ outcome: 'CANCELLED_IN_FLIGHT', late_outcome: 'ACCEPTED', late_smtp_code: 250 });
  });
  it('arrêt : l’email en cours se termine, aucun autre n’est réservé', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    let release!: () => void;
    t.gate = new Promise<void>((r) => { release = r; });
    const { sender, close } = await senderModule(t);
    const ids = [await seedPlainEmail(db), await seedPlainEmail(db), await seedPlainEmail(db)];
    const abort = new AbortController();
    const draining = sender.drain(SYSTEM, abort.signal);
    await waitUntil(() => t.sent.length === 1, 'premier envoi commencé');
    abort.abort();
    release();
    expect(await draining).toBe(1);
    await close();
    const statuses = await Promise.all(ids.map(async (id) => (await emailRow(db, id)).status));
    expect(statuses.filter((s) => s === 'ACCEPTED')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'PENDING')).toHaveLength(2);
  });
  it('un type sans modèle échoue en PERM_FAIL RENDER_FAILED, sans appel SMTP', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    const { sender, close } = await senderModule(t);
    const id = await seedPlainEmail(db, { kind: 'DIGEST' });
    await sender.drain(SYSTEM, live());
    await close();
    expect(t.sent).toHaveLength(0);
    expect((await emailRow(db, id)).status).toBe('FAILED');
    expect((await attemptRows(db, id))[0]).toMatchObject({ outcome: 'PERM_FAIL', error_code: 'RENDER_FAILED' });
  });
  it('un bail expiré est balayé au début du traitement (ambigu, jamais remis en file tel quel)', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    const { sender, close } = await senderModule(t);
    const id = await seedPlainEmail(db);
    const o = await connectAs('cp_app', db);
    await o.query(`update app.email_outbox set status = 'SENDING', claim_token = gen_random_uuid(), locked_until = clock_timestamp() - interval '1 second', normal_attempts = 1 where id = $1`, [id]);
    await o.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) select id, 1, 'NORMAL', claim_token from app.email_outbox where id = $1`, [id]);
    await o.end();
    await sender.drain(SYSTEM, live());
    await close();
    expect(await emailRow(db, id)).toMatchObject({ status: 'UNCERTAIN', scheduled: true });
    expect((await attemptRows(db, id))[0]).toMatchObject({ outcome: 'AMBIGUOUS', error_code: 'LEASE_EXPIRED' });
    expect(t.sent).toHaveLength(0);
  });
});

describe('baux (job_leases)', () => {
  const actor = { kind: 'system', job: 'maintenance.purge' } as const;
  async function leases() {
    const mod = await Test.createTestingModule({ imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, JobsSupportModule] }).compile();
    await mod.init();
    return { svc: mod.get(JobLeaseService), close: () => mod.close() };
  }
  it('huit acquisitions parallèles : une seule gagne, le jeton croît', async () => {
    const { svc, close } = await leases();
    const res = await Promise.all(Array.from({ length: 8 }, (_v, i) => svc.acquire(actor, `h${i}`, 60)));
    const winnerIndex = res.findIndex((r) => r !== null);
    expect(res.filter((r) => r !== null)).toHaveLength(1);
    const token = res[winnerIndex]!;
    const holder = `h${winnerIndex}`;
    expect(await svc.renew(actor, holder, token, 60)).toBe(true);
    expect(await svc.renew(actor, 'autre', token, 60)).toBe(false);
    await svc.release(actor, holder, token);
    const next = await svc.acquire(actor, 'suivant', 60);
    expect(next).toBeGreaterThan(token);
    await svc.release(actor, 'suivant', next!);
    await close();
  });
  it('un bail expiré se reprend ; une reprise qui attend un verrou tenu perd, une fois le bail renouvelé', async () => {
    const { svc, close } = await leases();
    const o = await connectAs('cp_app', db);
    await o.query(`update app.job_leases set lease_until = clock_timestamp() - interval '1 second' where name = 'maintenance.purge'`);
    await o.query('begin');
    const pid = (await o.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await o.query(`update app.job_leases set holder = 'b', lease_until = clock_timestamp() + interval '60 seconds', fencing_token = fencing_token + 1 where name = 'maintenance.purge'`);
    const racing = svc.acquire(actor, 'c', 60);
    await waitForLockWait(db, pid);
    await o.query('commit');
    expect(await racing).toBeNull(); // la condition est réévaluée : le bail est de nouveau valable
    await o.query(`update app.job_leases set lease_until = null where name = 'maintenance.purge'`);
    await o.end();
    await close();
  });
  it('seul l’acteur système prend un bail', async () => {
    const { svc, close } = await leases();
    await expect(svc.acquire({ kind: 'anonymous', ip: '203.0.113.1' } as never, 'x', 60)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await close();
  });
});

describe('purge horaire des seaux (R14 du lot 1a, R18)', () => {
  const purger = { kind: 'system', job: 'maintenance.purge' } as const;
  async function maintenance() {
    const mod = await Test.createTestingModule({ imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, MaintenanceModule] }).compile();
    await mod.init();
    return { svc: mod.get(MaintenanceService), close: () => mod.close() };
  }
  it('supprime par lots les seaux de plus de 2 h, garde les autres, ignore une ligne verrouillée sans attendre', async () => {
    const { svc, close } = await maintenance();
    const o = await connectAs('cp_app', db);
    for (let i = 0; i < 250; i++) await o.query(`insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp() - interval '3 hours')`, [`ip:10.1.0.${i}`]);
    await o.query(`insert into app.rate_limit_buckets (key, window_start) values ('ip:10.9.9.9', clock_timestamp() - interval '10 minutes')`);
    await o.query('begin');
    await o.query(`select key from app.rate_limit_buckets where key = 'ip:10.1.0.0' for update`);
    const t0 = Date.now();
    expect(await svc.purgeRateLimitBuckets(purger, 7200, 100)).toBe(249);
    expect(Date.now() - t0).toBeLessThan(3000);
    await o.query('rollback');
    expect(await svc.purgeRateLimitBuckets(purger, 7200, 100)).toBe(1);
    expect((await o.query(`select key from app.rate_limit_buckets where key = 'ip:10.9.9.9'`)).rows).toHaveLength(1);
    await o.end();
    await close();
  });
  it('refuse un acteur autre que le système', async () => {
    const { svc, close } = await maintenance();
    await expect(svc.purgeRateLimitBuckets({ kind: 'cli', command: 'create-class' } as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await close();
  });
});

describe('WorkerModule (de bout en bout)', () => {
  it('envoie au démarrage, se réveille par NOTIFY (sondage à 60 s) et s’arrête proprement', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    const before = await seedPlainEmail(db); // présent avant le démarrage : « chaque traitement s’exécute au démarrage »
    const mod = await Test.createTestingModule({ imports: [WorkerModule.forRoot(workerConfigFor(db), { transport: t, pollMs: 60_000 })] }).compile();
    await mod.init();
    const accepted = (id: string) => async () => (await emailRow(db, id)).status === 'ACCEPTED';
    await waitUntil(accepted(before), 'email préexistant envoyé');
    const woken = await seedPlainEmail(db);
    await waitUntil(accepted(woken), 'email réveillé par NOTIFY'); // 5 s au plus : le sondage (60 s) n'a pas pu le faire
    const t0 = Date.now();
    await mod.close();
    expect(Date.now() - t0).toBeLessThan(30_000);
  });
});

describe('purge : ne touche jamais un seau vivant', () => {
  const purger = { kind: 'system', job: 'maintenance.purge' } as const;
  it('garde les seaux dont la fenêtre (15 min) est vivante ou récente (< 2 h), supprime les plus vieux', async () => {
    const mod = await Test.createTestingModule({ imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, MaintenanceModule] }).compile();
    await mod.init();
    const o = await connectAs('cp_app', db);
    await o.query(`delete from app.rate_limit_buckets`);
    const ins = (key: string, ago: string) => o.query(`insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp() - interval '${ago}')`, [key]);
    await ins('ip:10.2.0.1', '1 minute'); // vivant
    await ins('ip:10.2.0.2', '14 minutes'); // vivant (fenêtre de 900 s)
    await ins('ip:10.2.0.3', '119 minutes'); // fenêtre échue mais sous la rétention
    await ins('ip:10.2.0.4', '121 minutes'); // à supprimer
    expect(await mod.get(MaintenanceService).purgeRateLimitBuckets(purger)).toBe(1);
    const keys = (await o.query(`select key from app.rate_limit_buckets order by key`)).rows.map((r) => r.key);
    expect(keys).toEqual(['ip:10.2.0.1', 'ip:10.2.0.2', 'ip:10.2.0.3']);
    await o.end();
    await mod.close();
  });
});

describe('perte du bail et envoi : bout en bout', () => {
  it('bail volé : le signal du traitement est annulé, le bail du voleur n’est pas libéré', async () => {
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, JobsSupportModule],
      providers: [{ provide: SCHEDULER_TIMING, useValue: { renewEveryMs: 20 } }, JobScheduler],
    }).compile();
    await mod.init();
    const scheduler = mod.get(JobScheduler);
    let signal: AbortSignal | undefined;
    let finished = false;
    scheduler.register({
      name: 'maintenance.purge', intervalMs: 3_600_000,
      run: (_a, s) => new Promise<void>((resolve) => { signal = s; s.addEventListener('abort', () => { finished = true; resolve(); }); }),
    });
    scheduler.start();
    await waitUntil(() => signal !== undefined, 'traitement démarré');
    expect(signal!.aborted).toBe(false);
    const o = await connectAs('cp_app', db);
    await o.query(`update app.job_leases set holder = 'voleur', fencing_token = fencing_token + 1, lease_until = clock_timestamp() + interval '60 seconds' where name = 'maintenance.purge'`);
    await waitUntil(() => finished, 'signal annulé après la perte du bail');
    expect(signal!.aborted).toBe(true);
    await scheduler.stop(5000); // attend la fin du passage, libération comprise
    expect((await o.query(`select holder, lease_until is not null as held from app.job_leases where name = 'maintenance.purge'`)).rows[0]).toEqual({ holder: 'voleur', held: true });
    await o.query(`update app.job_leases set lease_until = null where name = 'maintenance.purge'`);
    await o.end();
    await mod.close();
  });
  it('envoi dont la réservation a été reprise : le résultat tardif n’écrit rien sur l’email', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    let release!: () => void;
    t.gate = new Promise<void>((r) => { release = r; });
    const a = await senderModule(t);
    const id = await seedPlainEmail(db);
    const draining = a.sender.drain(SYSTEM, live());
    await waitUntil(() => t.sent.length === 1, 'envoi commencé');
    await forceEmail(db, id, `locked_until = clock_timestamp() - interval '1 second'`);
    const b = await senderModule(new FakeTransport()); // un autre worker balaie le bail expiré
    await b.sender.drain(SYSTEM, live());
    await b.close();
    release();
    await draining;
    await a.close();
    expect(await emailRow(db, id)).toMatchObject({ status: 'UNCERTAIN' }); // jamais ACCEPTED : le résultat périmé est abandonné
    expect((await attemptRows(db, id))[0]).toMatchObject({ outcome: 'AMBIGUOUS', error_code: 'LEASE_EXPIRED' });
  });
});

describe('arrêt du worker avec envoi en cours', () => {
  it('attend l’envoi en cours, le finalise, puis ferme sans rejet non traité', async () => {
    await cleanQueue();
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => { rejections.push(e); };
    process.on('unhandledRejection', onRej);
    const t = new FakeTransport();
    let release!: () => void;
    t.gate = new Promise<void>((r) => { release = r; });
    const id = await seedPlainEmail(db);
    const mod = await Test.createTestingModule({ imports: [WorkerModule.forRoot(workerConfigFor(db), { transport: t, pollMs: 60_000 })] }).compile();
    await mod.init();
    await waitUntil(() => t.sent.length === 1, 'envoi commencé');
    let closed = false;
    const closing = mod.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(false); // l'arrêt attend l'envoi en cours
    release();
    await closing;
    expect(await emailRow(db, id)).toMatchObject({ status: 'ACCEPTED' });
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', onRej);
    expect(rejections).toEqual([]);
  });
});
