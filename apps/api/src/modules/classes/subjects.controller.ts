import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CreateSubjectBody } from '@classepulse/shared';
import { EmptyBody } from '../../http/empty-body.js';
import { CurrentActor } from '../../http/current-actor.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { SubjectDto } from './class.dto.js';
import { ClassesService } from './classes.service.js';

/**
 * Matières de la classe (R12, écran M9) : liste, création et suppression.
 * Portée délégué/admin portée par le service (R2) ; la suppression « si utilisée » n'a rien à
 * refuser avant le lot 3 (aucune table ne référence `subjects`) — voir le plan.
 */
@Controller('classes/:classId/subjects')
export class SubjectsController {
  constructor(@Inject(ClassesService) private readonly svc: ClassesService) {}

  @Get()
  list(@CurrentActor() actor: UserActor, @Param('classId') classId: string): Promise<SubjectDto[]> {
    return this.svc.listSubjects(actor, classId);
  }

  @Post()
  create(@CurrentActor() actor: UserActor, @Param('classId') classId: string, @Body(new ZodPipe(CreateSubjectBody)) body: CreateSubjectBody): Promise<SubjectDto> {
    return this.svc.createSubject(actor, classId, body.name);
  }

  @Delete(':subjectId')
  @HttpCode(204)
  async delete(
    @CurrentActor() actor: UserActor,
    @Param('classId') classId: string,
    @Param('subjectId') subjectId: string,
    @Body(new ZodPipe(EmptyBody)) _body: unknown,
  ): Promise<void> {
    void _body; // lu uniquement pour être validé : aucun champ n'est accepté
    await this.svc.deleteSubject(actor, classId, subjectId);
  }
}
