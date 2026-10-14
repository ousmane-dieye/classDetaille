import { Inject, Injectable, Logger } from '@nestjs/common';
import pg from 'pg';
import { DB_CONFIG } from '../../config/config.module.js';
import { toPgPoolConfig } from '../../config/database-connection.js';
import type { DbConfig } from '../../config/load-config.js';

/** LISTEN email_outbox sur une connexion dédiée ; reconnexion automatique, avec rattrapage à chaque reconnexion. */
@Injectable()
export class NotifyListener {
  private readonly logger = new Logger('NotifyListener');
  private client: pg.Client | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;

  constructor(@Inject(DB_CONFIG) private readonly db: DbConfig) {}

  async start(onNotify: () => void): Promise<void> {
    this.stopped = false;
    await this.connect(onNotify);
  }

  private schedule(onNotify: () => void): void {
    if (this.stopped) return;
    this.retry = setTimeout(() => { this.retry = null; void this.connect(onNotify); }, 2000);
  }

  private async closeQuietly(client: pg.Client): Promise<void> {
    client.removeAllListeners();
    client.on('error', () => undefined);
    await client.end().catch(() => undefined);
  }

  private async connect(onNotify: () => void): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client(toPgPoolConfig(this.db));
    const lost = () => {
      if (this.stopped || this.client !== client) return;
      this.client = null;
      void this.closeQuietly(client);
      this.schedule(onNotify);
    };
    client.on('notification', () => onNotify());
    client.on('error', lost);
    client.on('end', lost);
    try {
      await client.connect();
      await client.query('listen email_outbox');
      if (this.stopped) { await this.closeQuietly(client); return; } // arrêt survenu pendant la connexion
      this.client = client;
      onNotify(); // rattrapage : un NOTIFY a pu passer pendant la coupure
    } catch {
      this.logger.warn('LISTEN connection failed, retrying');
      this.client = null;
      await this.closeQuietly(client);
      this.schedule(onNotify);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const c = this.client;
    this.client = null;
    if (c) await this.closeQuietly(c);
  }
}
