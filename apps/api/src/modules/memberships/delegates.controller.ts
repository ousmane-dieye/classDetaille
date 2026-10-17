import { Body, Controller, Delete, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { AppointDelegateBody } from '@classepulse/shared';
import { EmptyBody } from '../../http/empty-body.js';
import { CurrentActor } from '../../http/current-actor.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { DelegateDto } from './member.dto.js';
import { MembershipsService } from './memberships.service.js';

/**
 * Délégation (M12) : nomination et révocation par les administrateurs (matrice) ; la limite de deux
 * délégués vit en base (déclencheur, § 0.2 R8) et le service traduit son message.
 */
@Controller('classes/:classId/delegates')
export class DelegatesController {
  constructor(@Inject(MembershipsService) private readonly svc: MembershipsService) {}

  @Post()
  @HttpCode(200)
  appoint(@CurrentActor() actor: UserActor, @Param('classId') classId: string, @Body(new ZodPipe(AppointDelegateBody)) body: AppointDelegateBody): Promise<DelegateDto> {
    return this.svc.appointDelegate(actor, classId, body.userId);
  }

  @Delete(':userId')
  @HttpCode(200)
  async revoke(
    @CurrentActor() actor: UserActor,
    @Param('classId') classId: string,
    @Param('userId') userId: string,
    @Body(new ZodPipe(EmptyBody)) _body: unknown,
  ): Promise<DelegateDto> {
    void _body; // lu uniquement pour être validé : aucun champ n'est accepté
    return this.svc.revokeDelegate(actor, classId, userId);
  }
}
