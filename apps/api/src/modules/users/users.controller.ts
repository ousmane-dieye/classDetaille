import { Body, Controller, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { CreateEnrollmentBody, UpdatePreferencesBody, UpdateProfileBody } from '@classepulse/shared';
import { CurrentActor } from '../../http/current-actor.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { EnrollmentDto } from '../memberships/enrollment.dto.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import type { MeDto } from './me.dto.js';
import { MeService } from './me.service.js';
import { UsersService } from './users.service.js';

@Controller('me')
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(MeService) private readonly meService: MeService,
    @Inject(MembershipsService) private readonly memberships: MembershipsService,
  ) {}

  @Get()
  me(@CurrentActor() actor: UserActor): Promise<MeDto> {
    return this.meService.me(actor);
  }

  /** Re-demande d'adhésion d'un compte existant (R16) : le délai de 24 h et l'appartenance relèvent de la base. */
  @Post('enrollment')
  @HttpCode(201)
  createEnrollment(@CurrentActor() actor: UserActor, @Body(new ZodPipe(CreateEnrollmentBody)) body: CreateEnrollmentBody): Promise<EnrollmentDto> {
    return this.memberships.createEnrollment(actor, body.classId);
  }

  @Patch('profile')
  @HttpCode(200)
  async profile(@CurrentActor() actor: UserActor, @Body(new ZodPipe(UpdateProfileBody)) body: UpdateProfileBody): Promise<MeDto> {
    await this.users.updateProfile(actor, body);
    return this.meService.me(actor);
  }

  @Patch('email-preferences')
  @HttpCode(200)
  async preferences(@CurrentActor() actor: UserActor, @Body(new ZodPipe(UpdatePreferencesBody)) body: UpdatePreferencesBody): Promise<MeDto> {
    await this.users.updatePreferences(actor, body);
    return this.meService.me(actor);
  }
}
