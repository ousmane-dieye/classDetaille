import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { LoginBody, RegisterBody } from '@classepulse/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentActor } from '../../http/current-actor.js';
import { Public } from '../../http/public.decorator.js';
import { EmptyBody } from '../../http/empty-body.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { MeDto } from '../users/me.dto.js';
import { MeService } from '../users/me.service.js';
import { AuthService } from './auth.service.js';
import { clientContextOf } from './client-context.js';
import { sessionClearCookie, sessionSetCookie } from './session-cookie.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(MeService) private readonly me: MeService) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  async register(@Body(new ZodPipe(RegisterBody)) body: RegisterBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<MeDto> {
    const opened = await this.auth.register({ kind: 'anonymous', ip: req.ip }, body, clientContextOf(req));
    reply.header('set-cookie', sessionSetCookie(opened.token, opened.maxAgeSeconds));
    return this.me.me(opened.actor);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(LoginBody)) body: LoginBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<MeDto> {
    const opened = await this.auth.login({ kind: 'anonymous', ip: req.ip }, body, clientContextOf(req));
    reply.header('set-cookie', sessionSetCookie(opened.token, opened.maxAgeSeconds));
    return this.me.me(opened.actor);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentActor() actor: UserActor, @Body(new ZodPipe(EmptyBody)) _body: unknown, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(actor);
    reply.header('set-cookie', sessionClearCookie());
  }
}
