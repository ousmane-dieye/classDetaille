import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiModule } from './api.module.js';
import { loadConfig } from './config/load-config.js';
import { ReadinessProbe, ReadinessService } from './health/readiness.service.js';
import { buildReadyServer } from './health/ready-server.js';

@Injectable()
class AlwaysReady extends ReadinessProbe {
  async check() { return true; }
}

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create<NestFastifyApplication>(ApiModule.forRoot(config, AlwaysReady), new FastifyAdapter());
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen({ port: config.httpPort, host: '0.0.0.0' });
  const ready = buildReadyServer(app.get(ReadinessService));
  await ready.listen({ port: config.readyPort, host: '0.0.0.0' });
}

void bootstrap();
