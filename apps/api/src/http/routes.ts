import type { FastifyInstance } from 'fastify';

export type RouteInfo = { method: string; url: string };

/** Enregistre chaque route déclarée (méta-test, R11). HEAD, ajouté par Fastify, est ignoré. */
export function collectRoutes(fastify: FastifyInstance): RouteInfo[] {
  const routes: RouteInfo[] = [];
  fastify.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) if (method !== 'HEAD') routes.push({ method, url: r.url });
  });
  return routes;
}
