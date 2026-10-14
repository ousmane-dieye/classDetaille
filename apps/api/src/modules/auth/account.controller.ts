import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ChangePasswordBody } from '@classepulse/shared';
import type { FastifyRequest } from 'fastify';
import { CurrentActor } from '../../http/current-actor.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import { AuthService } from './auth.service.js';
import { clientContextOf } from './client-context.js';
import { SessionsService, type SessionDto } from './sessions.service.js';

@Controller('me')
export class AccountController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Post('password')
  @HttpCode(204)
  async changePassword(@CurrentActor() actor: UserActor, @Body(new ZodPipe(ChangePasswordBody)) body: ChangePasswordBody, @Req() req: FastifyRequest): Promise<void> {
    await this.auth.changePassword(actor, body, clientContextOf(req));
  }

  @Get('sessions')
  list(@CurrentActor() actor: UserActor): Promise<SessionDto[]> {
    return this.sessions.list(actor);
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers(@CurrentActor() actor: UserActor): Promise<{ revoked: number }> {
    return { revoked: await this.sessions.revokeOthers(actor) };
  }
}
