import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadWorkerConfig, type WorkerConfig } from './config/load-config.js';
import { WorkerModule } from './worker/worker.module.js';

async function main(): Promise<void> {
  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(process.env);
  } catch (e) {
    // Les messages du chargeur ne contiennent que des noms de variables, jamais de valeurs.
    process.stderr.write(`erreur : INVALID_CONFIGURATION\n${e instanceof Error ? e.message : ''}\n`);
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: config.logLevel === 'silent' ? false : ['log', 'warn', 'error'] });
  app.enableShutdownHooks(); // SIGTERM et SIGINT : arrêt en 30 s au plus (WorkerRuntime)
}

main().catch(() => { process.stderr.write('erreur : WORKER_START_FAILED\n'); process.exit(1); });
