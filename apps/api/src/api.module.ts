import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/load-config.js';
import { HealthModule } from './health/health.module.js';
import type { ReadinessProbe } from './health/readiness.service.js';

@Module({})
export class ApiModule {
  static forRoot(config: AppConfig, probe: Type<ReadinessProbe>, imports: DynamicModule['imports'] = []): DynamicModule {
    return { module: ApiModule, imports: [ConfigModule.forRoot(config), ...imports, HealthModule.register(probe, imports)] };
  }
}
