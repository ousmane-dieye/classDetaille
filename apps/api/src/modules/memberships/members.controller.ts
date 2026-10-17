import { Body, Controller, Delete, Get, HttpCode, Inject, Param } from '@nestjs/common';
import { RemoveMemberBody } from '@classepulse/shared';
import { CurrentActor } from '../../http/current-actor.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { MemberDto } from './member.dto.js';
import { MembershipsService } from './memberships.service.js';

/**
 * Membres de la classe (P8) : liste avec emails et retrait d'un membre (§ 4.5).
 * Portée délégué/admin portée par le service (R2) ; les paramètres uuid sont validés en service
 * (pas de ZodPipe sur `@Param` : un uuid malformé vaut 404, jamais de fuite d'existence).
 */
@Controller('classes/:classId/members')
export class MembersController {
  constructor(@Inject(MembershipsService) private readonly svc: MembershipsService) {}

  @Get()
  list(@CurrentActor() actor: UserActor, @Param('classId') classId: string): Promise<MemberDto[]> {
    return this.svc.listMembers(actor, classId);
  }

  @Delete(':userId')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: UserActor,
    @Param('classId') classId: string,
    @Param('userId') userId: string,
    @Body(new ZodPipe(RemoveMemberBody)) body: RemoveMemberBody,
  ): Promise<void> {
    await this.svc.remove(actor, classId, userId, body.note ?? null);
  }
}
