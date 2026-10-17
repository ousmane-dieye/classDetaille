import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { CreateClassBody } from '@classepulse/shared';
import type { FastifyRequest } from 'fastify';
import { EmptyBody } from '../../http/empty-body.js';
import { CurrentActor } from '../../http/current-actor.js';
import { Public } from '../../http/public.decorator.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { ClassAdminSummaryDto, ClassArchiveDto, ClassCreateDto, ClassDetailDto, ClassSummaryDto } from './class.dto.js';
import { ClassesService } from './classes.service.js';

/**
 * Classes : liste publique des actives (inscription) ; administration (liste toutes, création,
 * fiche + statistiques, archivage vérifié) — voir R1 et les actions `classes.*` de la matrice.
 * Les paramètres uuid sont validés en service (jamais de fuite d'existence, méta-test du lot 2).
 */
@Controller('classes')
export class ClassesController {
  constructor(@Inject(ClassesService) private readonly classes: ClassesService) {}

  /** Liste des classes actives, visible à l'inscription (§ 0.6). */
  @Public()
  @Get('active')
  listActive(@Req() req: FastifyRequest): Promise<ClassSummaryDto[]> {
    return this.classes.listActive(req.actor ?? { kind: 'anonymous', ip: req.ip });
  }

  /** Toutes les classes, archivées incluses (M11) : administrateurs seulement. */
  @Get()
  list(@CurrentActor() actor: UserActor): Promise<ClassAdminSummaryDto[]> {
    return this.classes.listAll(actor);
  }

  /** Création in-app (M11) : 201, mêmes validités que la CLI. */
  @Post()
  create(@CurrentActor() actor: UserActor, @Body(new ZodPipe(CreateClassBody)) body: CreateClassBody): Promise<ClassCreateDto> {
    return this.classes.createApp(actor, body);
  }

  /** Fiche + statistiques simples (M12, R11) : membre, délégué ou admin ; 404 pour les autres. */
  @Get(':classId')
  detail(@CurrentActor() actor: UserActor, @Param('classId') classId: string): Promise<ClassDetailDto> {
    return this.classes.detail(actor, classId);
  }

  /** Archivage vérifié (M13) : STEP_UP complet, clôture des appartenances dans la transaction. */
  @Post(':classId/archive')
  @HttpCode(200)
  async archive(
    @CurrentActor() actor: UserActor,
    @Param('classId') classId: string,
    @Body(new ZodPipe(EmptyBody)) _body: unknown,
  ): Promise<ClassArchiveDto> {
    void _body; // lu uniquement pour être validé : aucun champ n'est accepté
    return this.classes.archive(actor, classId);
  }
}
