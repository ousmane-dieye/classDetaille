import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ReadinessProbe, ReadinessService } from './readiness.service.js';

@Module({})
export class HealthModule {
  static register(probe: Type<ReadinessProbe>, imports: DynamicModule['imports'] = []): DynamicModule {
    return {
      module: HealthModule,
      imports,
      controllers: [HealthController],
      providers: [{ provide: ReadinessProbe, useExisting: probe }, probe, ReadinessService],
      exports: [ReadinessService],
    };
  }
}
