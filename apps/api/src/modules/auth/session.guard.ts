import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '../../http/current-actor.js';
import { ApiError } from '../../http/errors.js';
import { IS_PUBLIC } from '../../http/public.decorator.js';
import { SESSION_COOKIE } from '../../http/session-cookie-name.js';
import { sessionClearCookie } from './session-cookie.js';
import { SessionsService } from './sessions.service.js';

/** Garde global : toute route non marquée @Public() exige une session valide (refus par défaut). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED');
    const actor = await this.sessions.authenticate(token);
    if (!actor) {
      // Session invalide : 401 et effacement du cookie aux mêmes attributs (§ 3.4).
      ctx.switchToHttp().getResponse<FastifyReply>().header('set-cookie', sessionClearCookie());
      throw new ApiError(401, 'UNAUTHENTICATED');
    }
    req.actor = actor;
    return true;
  }
}
