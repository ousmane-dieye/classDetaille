import type { DynamicModule } from '@nestjs/common';
import { ThrottleGuardModule } from './throttle.js';

/** Modules métier de l'API (les tâches 9, 10 et 11 y ajoutent les leurs). La limitation générale vient en premier. */
export function defaultFeatures(): DynamicModule['imports'] {
  return [ThrottleGuardModule];
}
