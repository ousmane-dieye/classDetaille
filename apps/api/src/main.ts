import 'reflect-metadata';
import { loadConfig } from './config/load-config.js';
import { ReadinessService } from './health/readiness.service.js';
import { buildReadyServer } from './health/ready-server.js';
import { buildApiApp } from './http/app.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const { app } = await buildApiApp(config);
  const ready = buildReadyServer(app.get(ReadinessService));
  // L'arrêt de l'application publique ferme aussi le serveur interne.
  app.getHttpAdapter().getInstance().addHook('onClose', async () => { await ready.close(); });
  await app.listen({ port: config.httpPort, host: '0.0.0.0' });
  try {
    // Serveur interne : interrogé seulement par le contrôle de santé Docker, depuis le conteneur.
    await ready.listen({ port: config.readyPort, host: config.readyHost });
  } catch (e) {
    await app.close();
    throw e;
  }
}

bootstrap().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'bootstrap failed');
  process.exit(1);
});
