import { Controller, Get } from '@nestjs/common';
import { ReadinessService } from './readiness.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  async health(): Promise<{ status: 'ok' | 'degraded' }> {
    return { status: await this.readiness.publicStatus() };
  }
}
