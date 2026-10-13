import Fastify, { type FastifyInstance } from 'fastify';
import type { ReadinessService } from './readiness.service.js';

export function buildReadyServer(readiness: ReadinessService): FastifyInstance {
  const server = Fastify({ logger: false });
  server.get('/api/health/ready', async (_req, reply) => {
    const ok = await readiness.isReady();
    return reply.code(ok ? 200 : 503).send({ ready: ok });
  });
  return server;
}
