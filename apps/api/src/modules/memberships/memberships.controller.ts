import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { RefuseEnrollmentBody } from '@classepulse/shared';
import { EmptyBody } from '../../http/empty-body.js';
import { CurrentActor } from '../../http/current-actor.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { AcceptDecisionDto, RequestDto } from './enrollment.dto.js';
import { MembershipsService } from './memberships.service.js';

/**
 * Décision d'adhésion (P8) : délégués de la classe et administrateurs (affinage porté par le service, R2).
 * Les paramètres ne passent pas par un ZodPipe : un uuid mal formé vaut 404 au service (jamais de fuite d'existence).
 */
@Controller('classes/:classId/requests')
export class MembershipsController {
  constructor(@Inject(MembershipsService) private readonly svc: MembershipsService) {}

  @Get()
  list(@CurrentActor() actor: UserActor, @Param('classId') classId: string): Promise<RequestDto[]> {
    return this.svc.listRequests(actor, classId);
  }

  @Post(':requestId/accept')
  @HttpCode(200)
  accept(@CurrentActor() actor: UserActor, @Param('classId') classId: string, @Param('requestId') requestId: string, @Body(new ZodPipe(EmptyBody)) _body: unknown): Promise<AcceptDecisionDto> {
    void _body; // lu uniquement pour être validé : aucun champ n'est accepté
    return this.svc.accept(actor, classId, requestId);
  }

  @Post(':requestId/refuse')
  @HttpCode(204)
  refuse(
    @CurrentActor() actor: UserActor,
    @Param('classId') classId: string,
    @Param('requestId') requestId: string,
    @Body(new ZodPipe(RefuseEnrollmentBody)) body: RefuseEnrollmentBody,
  ): Promise<void> {
    return this.svc.refuse(actor, classId, requestId, body.note ?? null);
  }
}
