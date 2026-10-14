import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ChangePasswordBody, EmailChangeStartBody, PasswordBody, VerifyCodeBody } from '@classepulse/shared';
import type { FastifyRequest } from 'fastify';
import { CurrentActor } from '../../http/current-actor.js';
import { EmptyBody } from '../../http/empty-body.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import { MeService } from '../users/me.service.js';
import { AuthService } from './auth.service.js';
import { clientContextOf } from './client-context.js';
import { EmailChangeService } from './email-change.service.js';
import { StepUpService } from './step-up.service.js';
import { SessionsService, type SessionDto } from './sessions.service.js';

@Controller('me')
export class AccountController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SessionsService) private readonly sessions: SessionsService, @Inject(StepUpService) private readonly stepUp: StepUpService, @Inject(EmailChangeService) private readonly emailChange: EmailChangeService, @Inject(MeService) private readonly me: MeService) {}

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
  async revokeOthers(@CurrentActor() actor: UserActor, @Body(new ZodPipe(EmptyBody)) _body: unknown): Promise<{ revoked: number }> {
    void _body; // lu uniquement pour être validé : aucun champ n'est accepté
    return { revoked: await this.sessions.revokeOthers(actor) };
  }

  @Post('reauth') @HttpCode(204)
  async reauth(@CurrentActor() actor: UserActor, @Body(new ZodPipe(PasswordBody)) body: PasswordBody, @Req() req: FastifyRequest): Promise<void> {
    await this.stepUp.reauth(actor, body.password, clientContextOf(req));
  }
  @Post('step-up') @HttpCode(202)
  startStepUp(@CurrentActor() actor: UserActor, @Body(new ZodPipe(PasswordBody)) body: PasswordBody, @Req() req: FastifyRequest): Promise<{ expiresInSeconds: 600 }> {
    return this.stepUp.startStepUp(actor, body.password, clientContextOf(req));
  }
  @Post('email-change') @HttpCode(202)
  startEmailChange(@CurrentActor() actor: UserActor, @Body(new ZodPipe(EmailChangeStartBody)) body: EmailChangeStartBody, @Req() req: FastifyRequest): Promise<{ expiresInSeconds: 600 }> {
    return this.emailChange.start(actor, body, clientContextOf(req));
  }
  @Post('email-change/verify-old') @HttpCode(202)
  verifyOldEmail(@CurrentActor() actor: UserActor, @Body(new ZodPipe(VerifyCodeBody)) body: VerifyCodeBody, @Req() req: FastifyRequest): Promise<{ expiresInSeconds: 600 }> {
    return this.emailChange.verifyOld(actor, body.code, clientContextOf(req));
  }
  @Post('email-change/verify-new') @HttpCode(200)
  async verifyNewEmail(@CurrentActor() actor: UserActor, @Body(new ZodPipe(VerifyCodeBody)) body: VerifyCodeBody, @Req() req: FastifyRequest): ReturnType<MeService['me']> {
    await this.emailChange.verifyNew(actor, body.code, clientContextOf(req));
    return this.me.me(actor);
  }
  @Post('step-up/verify') @HttpCode(204)
  async verifyStepUp(@CurrentActor() actor: UserActor, @Body(new ZodPipe(VerifyCodeBody)) body: VerifyCodeBody, @Req() req: FastifyRequest): Promise<void> {
    await this.stepUp.verifyStepUp(actor, body.code, clientContextOf(req));
  }
}
