import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkerConfig } from '../../config/load-config.js';
import type { MailTransport } from '../mail/mail-transport.js';
import { MailWorkerModule } from '../mail/mail-worker.module.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { JobScheduler } from './job-scheduler.js';
import { JobsSupportModule } from './jobs-support.module.js';
import { NotifyListener } from './notify-listener.js';
import { WORKER_OPTIONS, WorkerRuntime } from './worker-runtime.js';

@Module({})
export class JobsModule {
  static register(config: WorkerConfig, o: { transport?: MailTransport; pollMs: number }): DynamicModule {
    return {
      module: JobsModule,
      imports: [JobsSupportModule, MaintenanceModule, MailWorkerModule.register(config, o.transport)],
      providers: [{ provide: WORKER_OPTIONS, useValue: { pollMs: o.pollMs } }, JobScheduler, NotifyListener, WorkerRuntime],
    };
  }
}
