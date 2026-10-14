import type { FastifyServerOptions } from 'fastify';
import type { LogLevel } from '../config/load-config.js';

/**
 * Chemins masqués par sécurité (§ 3.5) : les sérialiseurs n'écrivent déjà ni en-têtes, ni corps, ni chaîne de requête,
 * mais un objet journalisé ailleurs (`req.log.info({ … })`) ne doit jamais faire fuiter un cookie, une autorisation,
 * un mot de passe, un jeton ou un code.
 */
const REDACTED_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  'cookie',
  'authorization',
  'password', '*.password',
  'currentPassword', '*.currentPassword',
  'newPassword', '*.newPassword',
  'token', '*.token',
  'turnstileToken', '*.turnstileToken',
  'verificationCode', '*.verificationCode',
  'recoveryCode', '*.recoveryCode',
  // Code à usage unique (OTP) : seulement dans un corps de requête. Jamais un `code` nu, qui masquerait les codes d'erreur (`error.code`).
  'req.body.code', 'body.code', '*.body.code',
];

/** pino JSON (§ 3.5) : ni en-têtes, ni corps, ni chaîne de requête ; cookies, autorisations et secrets masqués. */
export function loggerOptions(level: LogLevel, stream?: NodeJS.WritableStream): NonNullable<FastifyServerOptions['logger']> {
  if (level === 'silent' && !stream) return false;
  return {
    level: level === 'silent' ? 'info' : level,
    ...(stream ? { stream } : {}),
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    serializers: {
      req: (req: { id: string; method: string; url: string; ip?: string }) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] ?? '', ip: req.ip }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  };
}
