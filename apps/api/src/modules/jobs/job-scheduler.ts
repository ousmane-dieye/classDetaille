import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { SystemActor } from '../authz/actor.js';
import { JobLeaseService, LEASE_SECONDS, RENEW_EVERY_MS } from './job-lease.service.js';

export type JobDef = { name: SystemActor['job']; intervalMs: number; run: (actor: SystemActor, signal: AbortSignal) => Promise<void> };
type Slot = { def: JobDef; running: Promise<void> | null; again: boolean; timer: NodeJS.Timeout | null };

export const SCHEDULER_TIMING = Symbol('SCHEDULER_TIMING');
/** Réglable pour les tests : durée du bail, période de renouvellement, horloge. */
export type SchedulerTiming = { leaseSeconds: number; renewEveryMs: number; now: () => number };
const DEFAULT_TIMING: SchedulerTiming = { leaseSeconds: LEASE_SECONDS, renewEveryMs: RENEW_EVERY_MS, now: () => Date.now() };

/**
 * Un bail par traitement (§ 1.4) ; bail pris ailleurs : on passe son tour ; un passage manqué est rattrapé au suivant.
 * Si le bail n'est plus à nous (renouvellement refusé, ou impossible assez longtemps pour qu'il ait pu expirer),
 * le signal du traitement est annulé : il cesse de travailler.
 */
@Injectable()
export class JobScheduler {
  private readonly logger = new Logger('JobScheduler');
  private readonly slots = new Map<string, Slot>();
  private readonly abort = new AbortController();
  private readonly holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly timing: SchedulerTiming;
  private stopping = false;

  constructor(
    @Inject(JobLeaseService) private readonly leases: JobLeaseService,
    @Optional() @Inject(SCHEDULER_TIMING) timing?: Partial<SchedulerTiming>,
  ) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  register(def: JobDef): void { this.slots.set(def.name, { def, running: null, again: false, timer: null }); }

  /** Chaque traitement s'exécute immédiatement au démarrage, puis à son intervalle. */
  start(): void {
    for (const [name, slot] of this.slots) {
      this.kick(name);
      slot.timer = setInterval(() => this.kick(name), slot.def.intervalMs);
    }
  }

  /** Demande un passage ; si un passage est en cours, un seul passage de rattrapage est mémorisé. */
  kick(name: string): void {
    const slot = this.slots.get(name);
    if (!slot || this.stopping) return;
    if (slot.running) { slot.again = true; return; }
    slot.running = this.cycle(slot).finally(() => {
      slot.running = null;
      if (slot.again && !this.stopping) { slot.again = false; this.kick(name); }
    });
  }

  /** Ne rejette jamais : toute erreur est journalisée (sans message, qui pourrait citer une donnée). */
  private async cycle(slot: Slot): Promise<void> {
    const actor: SystemActor = { kind: 'system', job: slot.def.name };
    const { leaseSeconds, renewEveryMs, now } = this.timing;
    let token: number | null;
    try { token = await this.leases.acquire(actor, this.holder, leaseSeconds); } catch { this.logger.error(`lease acquisition failed for ${actor.job}`); return; }
    if (token === null) return; // le bail est pris ailleurs
    const held = token;
    // Signal du traitement : arrêt du processus OU bail perdu.
    const job = new AbortController();
    const onStop = () => job.abort();
    this.abort.signal.addEventListener('abort', onStop, { once: true });
    let lastRenewed = now();
    let renewing = false;
    const renew = setInterval(() => {
      if (renewing || job.signal.aborted) return;
      renewing = true;
      this.leases.renew(actor, this.holder, held, leaseSeconds)
        .then((ok) => {
          if (ok) { lastRenewed = now(); return; }
          this.logger.warn(`lease lost for ${actor.job}, aborting the job`);
          job.abort();
        })
        .catch(() => {
          // Erreur transitoire : on ne conclut à la perte que si le bail a pu expirer sans renouvellement.
          if (now() - lastRenewed >= (leaseSeconds * 1000) - renewEveryMs) {
            this.logger.warn(`lease renewal failing for ${actor.job}, aborting the job`);
            job.abort();
          }
        })
        .finally(() => { renewing = false; });
    }, renewEveryMs);
    try {
      await slot.def.run(actor, job.signal);
    } catch (e) {
      this.logger.error(`job ${actor.job} failed (${e instanceof Error ? e.constructor.name : 'unknown'})`);
    } finally {
      clearInterval(renew);
      this.abort.signal.removeEventListener('abort', onStop);
      // Sans effet si le bail n'est plus le nôtre (détenteur et jeton vérifiés dans l'instruction).
      await this.leases.release(actor, this.holder, held).catch(() => undefined);
    }
  }

  /** À SIGTERM : on cesse de réserver, l'envoi en cours se termine, dans la limite de `deadlineMs` (30 s). */
  async stop(deadlineMs: number): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    for (const slot of this.slots.values()) if (slot.timer) clearInterval(slot.timer);
    const running = [...this.slots.values()].map((s) => s.running).filter((r): r is Promise<void> => r !== null);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.allSettled(running), new Promise<void>((r) => { timer = setTimeout(r, deadlineMs); })]);
    } finally {
      clearTimeout(timer);
    }
  }
}
