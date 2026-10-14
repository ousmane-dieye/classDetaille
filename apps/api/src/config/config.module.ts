import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig, DbConfig, WorkerConfig } from './load-config.js';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');
/** Connexion à la base : fournie par l'API (AppConfig.db) et par le worker (WorkerConfig.db). */
export const DB_CONFIG = Symbol('DB_CONFIG');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: ConfigModule, providers: [{ provide: APP_CONFIG, useValue: config }, { provide: DB_CONFIG, useValue: config.db }], exports: [APP_CONFIG, DB_CONFIG] };
  }
}

@Global()
@Module({})
export class WorkerConfigModule {
  static forRoot(config: WorkerConfig): DynamicModule {
    return { module: WorkerConfigModule, providers: [{ provide: WORKER_CONFIG, useValue: config }, { provide: DB_CONFIG, useValue: config.db }], exports: [WORKER_CONFIG, DB_CONFIG] };
  }
}

export type { DbConfig };
