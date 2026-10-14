import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { ReadinessProbe } from '../health/readiness.service.js';
import { PrismaService, prismaServiceProvider } from './prisma.service.js';

@Injectable()
export class DatabaseReadinessProbe extends ReadinessProbe {
  private readonly logger = new Logger('DatabaseReadinessProbe');
  /** Évite de répéter l'avertissement à chaque contrôle tant que le réglage reste en place. */
  private overrideReported = false;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) { super(); }

  async check(): Promise<boolean> {
    if (!(await this.prisma.ping())) return false;
    // G4 : un réglage log_* enregistré sur un rôle ou sur la base rend l'API non prête.
    if (await this.prisma.hasLogSettingOverrides()) {
      // Aucune valeur de réglage dans le message.
      if (!this.overrideReported) this.logger.warn('log_* override detected on role/database');
      this.overrideReported = true;
      return false;
    }
    this.overrideReported = false;
    return true;
  }
}

@Global()
@Module({ providers: [prismaServiceProvider, DatabaseReadinessProbe], exports: [PrismaService, DatabaseReadinessProbe] })
export class DatabaseModule {}
