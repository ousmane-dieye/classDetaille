import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { DB_CONFIG } from '../config/config.module.js';
import { toPgPoolConfig } from '../config/database-connection.js';
import type { DbConfig } from '../config/load-config.js';
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

  /**
   * Détection G4 : vrai si un réglage `log_*` est enregistré sur un rôle (`ALTER ROLE … SET`) ou sur la base
   * courante (`ALTER DATABASE … SET`), pour tout le serveur (setdatabase = 0) ou cette base.
   * Ne renvoie qu'un booléen : les valeurs de setconfig ne sont jamais lues par l'application.
   */
  async hasLogSettingOverrides(): Promise<boolean> {
    const r = await this.client.$queryRaw<{ found: boolean }[]>`
      select exists (
        select 1 from pg_db_role_setting s, unnest(s.setconfig) c
         where c ilike 'log\\_%'
           and (s.setdatabase = 0 or s.setdatabase = (select oid from pg_database where datname = current_database()))
      ) as found`;
    return r[0]?.found === true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

export const prismaServiceProvider = {
  provide: PrismaService,
  inject: [DB_CONFIG],
  useFactory: (db: DbConfig) => new PrismaService(db),
};
