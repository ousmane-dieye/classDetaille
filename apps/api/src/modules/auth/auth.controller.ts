import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { LoginBody, RegisterBody, VerifyCodeBody } from '@classepulse/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentActor } from '../../http/current-actor.js';
import { Public } from '../../http/public.decorator.js';
import { EmptyBody } from '../../http/empty-body.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { MeDto } from '../users/me.dto.js';
import { MeService } from '../users/me.service.js';
import { adminCodeRequiredDto, type AdminCodeRequiredDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { CHALLENGE_COOKIE } from '../../http/session-cookie-name.js';
import { challengeClearCookie, challengeSetCookie } from './second-factor/otp.js';
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

  /** `@Res()` sans passthrough : le statut (200 étudiant, 202 administrateur) et les cookies sont posés explicitement. */
  @Public()
  @Post('login')
  async login(@Body(new ZodPipe(LoginBody)) body: LoginBody, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const r = await this.auth.login({ kind: 'anonymous', ip: req.ip }, body, clientContextOf(req));
    if (r.kind === 'second-factor') {
      await reply.code(202).header('set-cookie', challengeSetCookie(r.sent.cookieToken)).send(adminCodeRequiredDto(r.sent));
      return;
    }
    const me: MeDto = await this.me.me(r.opened.actor);
    await reply.code(200).header('set-cookie', sessionSetCookie(r.opened.token, r.opened.maxAgeSeconds)).send(me);
  }

  @Public()
  @Post('verify-code')
  @HttpCode(200)
  async verifyCode(@Body(new ZodPipe(VerifyCodeBody)) body: VerifyCodeBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<MeDto> {
    const opened = await this.auth.verifyCode({ kind: 'anonymous', ip: req.ip }, body, req.cookies?.[CHALLENGE_COOKIE], clientContextOf(req));
    reply.header('set-cookie', [sessionSetCookie(opened.token, opened.maxAgeSeconds), challengeClearCookie()]);
    return this.me.me(opened.actor);
  }

  @Public()
  @Post('resend-code')
  @HttpCode(202)
  async resendCode(@Body(new ZodPipe(EmptyBody)) _body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<AdminCodeRequiredDto> {
    const sent = await this.auth.resendCode({ kind: 'anonymous', ip: req.ip }, req.cookies?.[CHALLENGE_COOKIE], clientContextOf(req));
    reply.header('set-cookie', challengeSetCookie(sent.cookieToken));
    return adminCodeRequiredDto(sent);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentActor() actor: UserActor, @Body(new ZodPipe(EmptyBody)) _body: unknown, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(actor);
    reply.header('set-cookie', sessionClearCookie());
  }
}
