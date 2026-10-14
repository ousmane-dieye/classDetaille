import type { DynamicModule } from '@nestjs/common';
import type { AppConfig } from '../config/load-config.js';
import { AuditModule } from '../modules/audit/audit.module.js';
import { AuthModule } from '../modules/auth/auth.module.js';
import { AuthzModule } from '../modules/authz/authz.module.js';
import { ClassesModule } from '../modules/classes/classes.module.js';
import { MembershipsModule } from '../modules/memberships/memberships.module.js';
import { UsersModule } from '../modules/users/users.module.js';
import type { AppOverrides } from './app.js';

/** Modules métier de l'API. La limitation générale est déclarée par AuthModule, avant le garde de session. */
export function defaultFeatures(config: AppConfig, o: AppOverrides): DynamicModule['imports'] {
  return [AuthzModule, AuditModule, UsersModule, ClassesModule, MembershipsModule, AuthModule.register(config, o)];
}
