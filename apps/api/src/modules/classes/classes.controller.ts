import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import '../../http/current-actor.js';
import { Public } from '../../http/public.decorator.js';
import type { ClassSummaryDto } from './class.dto.js';
import { ClassesService } from './classes.service.js';

@Controller('classes')
export class ClassesController {
  constructor(@Inject(ClassesService) private readonly classes: ClassesService) {}

  /** Liste des classes actives, visible à l'inscription (§ 0.6). */
  @Public()
  @Get('active')
  listActive(@Req() req: FastifyRequest): Promise<ClassSummaryDto[]> {
    return this.classes.listActive(req.actor ?? { kind: 'anonymous', ip: req.ip });
  }
}
