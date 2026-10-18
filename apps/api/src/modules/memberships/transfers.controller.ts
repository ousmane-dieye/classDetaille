import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { TransferBatchBody, TransferBody } from '@classepulse/shared';
import { CurrentActor } from '../../http/current-actor.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { TransferBatchDto, TransferDto } from './member.dto.js';
import { MembershipsService } from './memberships.service.js';

/**
 * Transfert (M13, R7) : administrateurs seulement (matrice) ; la portée et les gardes de fraîcheur
 * sont portés par le service. Les paramètres uuid sont validés en service (un uuid malformé vaut 404,
 * jamais de fuite d'existence) ; le corps, lui, passe par ZodPipe.
 */
@Controller('users')
export class TransfersController {
  constructor(@Inject(MembershipsService) private readonly svc: MembershipsService) {}

  /** Transfert simple : la personne vers sa nouvelle classe ; mot de passe récent exigé. */
  @Post(':userId/transfer')
  @HttpCode(200)
  transfer(@CurrentActor() actor: UserActor, @Param('userId') userId: string, @Body(new ZodPipe(TransferBody)) body: TransferBody): Promise<TransferDto> {
    return this.svc.transfer(actor, userId, body.toClassId);
  }
}

/** Transfert en masse (M13) : `:classId` est la destination du lot ; vérification complète exigée. */
@Controller('classes/:classId/transfers')
export class ClassTransfersController {
  constructor(@Inject(MembershipsService) private readonly svc: MembershipsService) {}

  @Post()
  @HttpCode(200)
  transferMass(@CurrentActor() actor: UserActor, @Param('classId') classId: string, @Body(new ZodPipe(TransferBatchBody)) body: TransferBatchBody): Promise<TransferBatchDto> {
    return this.svc.transferMass(actor, classId, body.userIds);
  }
}
