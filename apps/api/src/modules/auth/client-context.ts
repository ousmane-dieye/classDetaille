import type { FastifyRequest } from 'fastify';

export type ClientContext = { ip: string; userAgent: string | null };

export function clientContextOf(req: FastifyRequest): ClientContext {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' && ua.length > 0 ? ua.slice(0, 512) : null };
}
