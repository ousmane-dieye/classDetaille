import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/load-config.js';
import { HealthModule } from './health/health.module.js';
import type { ReadinessProbe } from './health/readiness.service.js';

/** Module racine : `infra` (base, horloge…) est aussi fourni au module de santé ; les modules métier arrivent par `features`. */
@Module({})
export class ApiModule {
  static forRoot(config: AppConfig, probe: Type<ReadinessProbe>, infra: DynamicModule['imports'] = [], features: DynamicModule['imports'] = []): DynamicModule {
    return { module: ApiModule, imports: [ConfigModule.forRoot(config), ...infra, ...features, HealthModule.register(probe, infra)] };
  }
}
