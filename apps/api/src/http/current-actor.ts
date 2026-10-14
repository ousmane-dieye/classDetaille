import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { UserActor } from '../modules/authz/actor.js';
import { ApiError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest { actor?: UserActor }
}

/** Acteur posé par le garde de session ; absent seulement sur une route @Public(). */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): UserActor => {
  const actor = ctx.switchToHttp().getRequest<FastifyRequest>().actor;
  if (!actor) throw new ApiError(401, 'UNAUTHENTICATED');
  return actor;
});
