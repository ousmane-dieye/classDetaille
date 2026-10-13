import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG } from '../config/config.module.js';
import { toPgPoolConfig } from '../config/database-connection.js';
import type { AppConfig, DbConfig } from '../config/load-config.js';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { runWithRetry } from './tx.js';

export type TxClient = Prisma.TransactionClient;

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(db: DbConfig) {
    this.client = new PrismaClient({ adapter: new PrismaPg(toPgPoolConfig(db)) });
  }

  withTx<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return runWithRetry(() =>
      this.client.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 }),
    );
  }

  async ping(): Promise<boolean> {
    const r = await this.client.$queryRaw<{ ok: number }[]>`select 1 as ok`;
    return r[0]?.ok === 1;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

export const prismaServiceProvider = {
  provide: PrismaService,
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) => new PrismaService(cfg.db),
};
