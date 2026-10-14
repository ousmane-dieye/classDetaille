import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import type { AppConfig } from '../config/load-config.js';
import { DatabaseModule } from '../database/database.module.js';
import { CoreModule } from '../http/core.module.js';
import { AuditModule } from '../modules/audit/audit.module.js';
import { AuthzModule } from '../modules/authz/authz.module.js';
import { ClassesModule } from '../modules/classes/classes.module.js';
import { UsersModule } from '../modules/users/users.module.js';

@Module({})
export class CliModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: CliModule, imports: [ConfigModule.forRoot(config), DatabaseModule, CoreModule.forRoot(), AuthzModule, AuditModule, UsersModule, ClassesModule] };
  }
}
