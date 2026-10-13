import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ReadinessProbe } from '../health/readiness.service.js';
import { PrismaService, prismaServiceProvider } from './prisma.service.js';

@Injectable()
export class DatabaseReadinessProbe extends ReadinessProbe {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) { super(); }
  check(): Promise<boolean> { return this.prisma.ping(); }
}

@Global()
@Module({ providers: [prismaServiceProvider, DatabaseReadinessProbe], exports: [PrismaService, DatabaseReadinessProbe] })
export class DatabaseModule {}
