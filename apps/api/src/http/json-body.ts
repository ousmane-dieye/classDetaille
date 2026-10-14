import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';

/** Taille maximale d'un corps de requête (§ 3.5). */
export const BODY_LIMIT_BYTES = 100 * 1024;

/**
 * Seul `application/json` est lu (§ 3.5) : les analyseurs par défaut de Fastify (JSON, texte) sont retirés et
 * remplacés par celui-ci. Un corps vide ou invalide donne `400 INVALID_JSON` (l'analyseur de Fastify lèverait
 * FST_ERR_CTP_INVALID_JSON_BODY, que l'adaptateur de Nest réduit à un statut) ; au-delà de la limite, Fastify
 * répond 413 avant l'analyse. La protection contre `__proto__` et `constructor` de Fastify est conservée.
 */
export function registerJsonBodyParser(fastify: FastifyInstance): void {
  const parse = fastify.getDefaultJsonParser('error', 'error');
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: BODY_LIMIT_BYTES }, (req, body, done) => {
    parse(req, body.toString(), (err, value) => {
      if (err) done(new ApiError(400, 'INVALID_JSON'), undefined);
      else done(null, value);
    });
  });
}
