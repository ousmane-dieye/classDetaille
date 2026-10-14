import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../http/public.decorator.js';
import { ReadinessService } from './readiness.service.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  @Get()
  async health(): Promise<{ status: 'ok' | 'degraded' }> {
    return { status: await this.readiness.publicStatus() };
  }
}
