import { Module, type DynamicModule } from '@nestjs/common';
import { WorkerConfigModule } from '../config/config.module.js';
import type { WorkerConfig } from '../config/load-config.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthzModule } from '../modules/authz/authz.module.js';
import { JobsModule } from '../modules/jobs/jobs.module.js';
import type { MailTransport } from '../modules/mail/mail-transport.js';

@Module({})
export class WorkerModule {
  static forRoot(config: WorkerConfig, o: { transport?: MailTransport; pollMs?: number } = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        WorkerConfigModule.forRoot(config), DatabaseModule, AuthzModule,
        JobsModule.register(config, { ...(o.transport ? { transport: o.transport } : {}), pollMs: o.pollMs ?? 15_000 }),
      ],
    };
  }
}
