import type { DynamicModule } from '@nestjs/common';
import { AuditModule } from '../modules/audit/audit.module.js';
import { AuthzModule } from '../modules/authz/authz.module.js';
import { ClassesModule } from '../modules/classes/classes.module.js';
import { MembershipsModule } from '../modules/memberships/memberships.module.js';
import { UsersModule } from '../modules/users/users.module.js';
import { ThrottleGuardModule } from './throttle.js';

/** Modules métier de l'API (les tâches 10 et 11 y ajoutent les leurs). La limitation générale vient en premier. */
export function defaultFeatures(): DynamicModule['imports'] {
  return [ThrottleGuardModule, AuthzModule, AuditModule, UsersModule, ClassesModule, MembershipsModule];
}
