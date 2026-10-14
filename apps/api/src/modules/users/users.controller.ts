import { Body, Controller, Get, HttpCode, Inject, Patch } from '@nestjs/common';
import { UpdatePreferencesBody, UpdateProfileBody } from '@classepulse/shared';
import { CurrentActor } from '../../http/current-actor.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { MeDto } from './me.dto.js';
import { MeService } from './me.service.js';
import { UsersService } from './users.service.js';

@Controller('me')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService, @Inject(MeService) private readonly meService: MeService) {}

  @Get()
  me(@CurrentActor() actor: UserActor): Promise<MeDto> {
    return this.meService.me(actor);
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
