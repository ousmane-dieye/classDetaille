import { createHash, randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ThrottlerModule } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { ApiModule } from '../api.module.js';
import type { AppConfig } from '../config/load-config.js';
import { DatabaseModule, DatabaseReadinessProbe } from '../database/database.module.js';
import type { ReadinessProbe } from '../health/readiness.service.js';
import type { TurnstileVerifier } from '../modules/auth/turnstile.js';
import type { Clock } from './clock.js';
import { CoreModule } from './core.module.js';
import { registerCsrf } from './csrf.js';
import { AllExceptionsFilter } from './errors.js';
import { defaultFeatures } from './features.js';
import { ipPrefix, trustProxyHops } from './ip.js';
import { BODY_LIMIT_BYTES, registerJsonBodyParser } from './json-body.js';
import { loggerOptions } from './logger.js';
import { collectRoutes, type RouteInfo } from './routes.js';
import { SESSION_COOKIE } from './session-cookie-name.js';

export { BODY_LIMIT_BYTES } from './json-body.js';

export type AppOverrides = {
  probe?: Type<ReadinessProbe>;
  /** Vérificateur Turnstile de remplacement (tests). Par défaut : HttpTurnstileVerifier (tâche 10). */
  turnstile?: TurnstileVerifier;
  clock?: Clock;
  logStream?: NodeJS.WritableStream;
  features?: (config: AppConfig, o: AppOverrides) => DynamicModule['imports'];
};

const THROTTLE_WINDOW_MS = 60_000;

function throttlerModule(config: AppConfig): DynamicModule {
  const cookieOf = (req: Record<string, unknown>) => (req as unknown as FastifyRequest).cookies?.[SESSION_COOKIE];
  return ThrottlerModule.forRoot({
    // Une seule clé par limiteur et par client pour toute l'API (et non une par route, comportement par défaut).
    generateKey: (_ctx, tracker, name) => `${name}:${tracker}`,
    throttlers: [
      // IPv6 : préfixe /64, comme les autres limites (§ 2.2).
      { name: 'ip', ttl: THROTTLE_WINDOW_MS, limit: config.limits.throttlePerIp, getTracker: (req) => ipPrefix(String((req as unknown as FastifyRequest).ip)) },
      {
        name: 'session', ttl: THROTTLE_WINDOW_MS, limit: config.limits.throttlePerSession,
        // Le jeton n'est jamais gardé en mémoire tel quel : seule son empreinte sert de clé.
        getTracker: (req) => createHash('sha256').update(String(cookieOf(req))).digest('hex'),
        skipIf: (ctx) => !cookieOf(ctx.switchToHttp().getRequest()),
      },
    ],
  });
}

export async function buildApiApp(config: AppConfig, o: AppOverrides = {}): Promise<{ app: NestFastifyApplication; routes: RouteInfo[] }> {
  const adapter = new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: trustProxyHops(config.http.trustProxy),
    genReqId: () => randomUUID(),
    requestIdHeader: false, // l'identifiant est toujours généré par le serveur
    logger: loggerOptions(config.http.logLevel, o.logStream),
  });
  const fastify = adapter.getInstance();
  const routes = collectRoutes(fastify);
  registerJsonBodyParser(fastify);
  registerCsrf(fastify, config.http.origin);
  fastify.addHook('onSend', async (req, reply) => { reply.header('x-request-id', req.id); });

  const features = (o.features ?? defaultFeatures)(config, o) ?? [];
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.forRoot(config, o.probe ?? DatabaseReadinessProbe, [DatabaseModule, CoreModule.forRoot(o.clock)], [throttlerModule(config), ...features]),
    adapter,
    {
      // Les analyseurs de Nest (JSON et formulaires) ne sont pas installés : seul celui de registerJsonBodyParser lit les corps.
      bodyParser: false,
      logger: config.http.logLevel === 'silent' || config.nodeEnv === 'test' ? false : ['error', 'warn', 'log'],
    },
  );
  await app.register(fastifyCookie);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  await app.init();
  await fastify.ready();
  return { app, routes };
}
