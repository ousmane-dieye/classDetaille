import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { EmailSender } from '../mail/email-sender.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { JobScheduler } from './job-scheduler.js';
import { NotifyListener } from './notify-listener.js';

export const WORKER_OPTIONS = Symbol('WORKER_OPTIONS');
export type WorkerOptions = { pollMs: number };
/** Budget d'arrêt à SIGTERM (§ 1.4). */
export const SHUTDOWN_DEADLINE_MS = 30_000;
export const PURGE_EVERY_MS = 3_600_000;

/**
 * L'arrêt se fait dans `onModuleDestroy`, avant la fermeture du pool de base (même crochet, ordre inverse des
 * dépendances) : un envoi en cours peut encore finaliser.
 */
@Injectable()
export class WorkerRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    @Inject(JobScheduler) private readonly scheduler: JobScheduler,
    @Inject(NotifyListener) private readonly listener: NotifyListener,
    @Inject(EmailSender) private readonly sender: EmailSender,
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
    @Inject(WORKER_OPTIONS) private readonly options: WorkerOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.scheduler.register({ name: 'email.send', intervalMs: this.options.pollMs, run: async (actor, signal) => { await this.sender.drain(actor, signal); } });
    this.scheduler.register({ name: 'maintenance.purge', intervalMs: PURGE_EVERY_MS, run: async (actor, signal) => { await this.maintenance.purgeRateLimitBuckets(actor, undefined, undefined, signal); } });
    this.scheduler.start();
    await this.listener.start(() => this.scheduler.kick('email.send'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.listener.stop();
    await this.scheduler.stop(SHUTDOWN_DEADLINE_MS);
  }
}
