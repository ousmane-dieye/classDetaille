import type { FastifyInstance } from 'fastify';
import { errorBody } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Tableau du § 3.5 : Origin fait foi s'il est présent ; sinon seul Sec-Fetch-Site: same-origin est accepté. */
export function csrfDecision(origin: string | undefined, secFetchSite: string | undefined, appOrigin: string): 'accept' | 'reject' {
  if (origin !== undefined) return origin === appOrigin ? 'accept' : 'reject';
  return secFetchSite === 'same-origin' ? 'accept' : 'reject';
}

export function isJsonContentType(ct: string | undefined): boolean {
  return ct !== undefined && /^application\/json\s*(;|$)/i.test(ct.trim());
}

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Crochet onRequest : toutes les requêtes modifiantes, avant le routage et la lecture du corps. */
export function registerCsrf(fastify: FastifyInstance, appOrigin: string): void {
  fastify.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (csrfDecision(single(req.headers.origin), single(req.headers['sec-fetch-site']), appOrigin) === 'reject') {
      return reply.code(403).send(errorBody('CSRF_REJECTED', req.id));
    }
    if (!isJsonContentType(single(req.headers['content-type']))) {
      return reply.code(415).send(errorBody('UNSUPPORTED_MEDIA_TYPE', req.id));
    }
  });
}
