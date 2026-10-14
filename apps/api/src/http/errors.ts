import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Erreur métier : un code stable (anglais), des champs sûrs (jamais une valeur saisie) et des en-têtes éventuels. */
export class ApiError extends HttpException {
  constructor(status: number, readonly code: string, readonly extra: Record<string, unknown> = {}, readonly headers: Record<string, string> = {}) {
    super({ code, ...extra }, status);
  }
}

const GENERIC: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'TOO_MANY_REQUESTS', 503: 'UNAVAILABLE',
};

export function errorBody(code: string, requestId: string, extra: Record<string, unknown> = {}) {
  return { error: { code, ...extra }, requestId };
}

type ErrorResponse = { status: number; body: ReturnType<typeof errorBody>; headers: Record<string, string> };

/**
 * Format commun `{ error: { code, … }, requestId }`, sans trace ni message. Les erreurs de Fastify (corps trop gros,
 * type de contenu sans analyseur…) arrivent déjà transformées en `HttpException(message, statusCode)` par
 * l'adaptateur de Nest : seul leur statut est repris. Toute autre erreur donne 500 INTERNAL.
 */
export function toErrorResponse(e: unknown, requestId: string): ErrorResponse {
  if (e instanceof ApiError) return { status: e.getStatus(), body: errorBody(e.code, requestId, e.extra), headers: e.headers };
  if (e instanceof HttpException) {
    const status = e.getStatus();
    const r = e.getResponse();
    // Seuls les objets construits par notre code ({ code, … }) sont recopiés ; jamais un message de Nest ou de Fastify.
    if (typeof r === 'object' && r !== null && typeof (r as { code?: unknown }).code === 'string') {
      const { code, ...rest } = r as { code: string } & Record<string, unknown>;
      return { status, body: errorBody(code, requestId, rest), headers: {} };
    }
    return { status, body: errorBody(GENERIC[status] ?? 'ERROR', requestId), headers: {} };
  }
  return { status: 500, body: errorBody('INTERNAL', requestId), headers: {} };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(e: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const { status, body, headers } = toErrorResponse(e, req.id);
    // Jamais le message : il peut contenir une valeur saisie. Seul le type d'erreur est journalisé.
    if (status >= 500) this.logger.error(`unhandled ${e instanceof Error ? e.name : typeof e} (request ${req.id})`);
    void reply.status(status).headers(headers).send(body);
  }
}
