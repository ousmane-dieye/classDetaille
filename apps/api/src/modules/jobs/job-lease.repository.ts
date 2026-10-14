import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

/** Chaque opération est une instruction unique : jamais de lecture suivie d'une écriture. */
@Injectable()
export class JobLeaseRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Acquisition atomique (§ 1.4) : une ligne est renvoyée au gagnant, aucune aux autres. */
  async acquire(name: string, holder: string, ttlSeconds: number): Promise<number | null> {
    const r = await this.prisma.client.$queryRaw<{ token: string }[]>`
      update app.job_leases set holder = ${holder}, lease_until = clock_timestamp() + make_interval(secs => ${ttlSeconds}::double precision), fencing_token = fencing_token + 1
       where name = ${name} and (lease_until is null or lease_until < clock_timestamp())
      returning fencing_token::text as token`;
    return r[0] ? Number(r[0].token) : null;
  }

  /** Vrai seulement si le bail est encore le nôtre (même détenteur, même jeton) et n'a pas expiré. */
  async renew(name: string, holder: string, token: number, ttlSeconds: number): Promise<boolean> {
    const r = await this.prisma.client.$queryRaw<{ n: number }[]>`
      update app.job_leases set lease_until = clock_timestamp() + make_interval(secs => ${ttlSeconds}::double precision)
       where name = ${name} and holder = ${holder} and fencing_token = ${token}::bigint and lease_until >= clock_timestamp()
      returning 1 as n`;
    return r.length === 1;
  }

  async release(name: string, holder: string, token: number): Promise<void> {
    await this.prisma.client.$executeRaw`
      update app.job_leases set lease_until = null where name = ${name} and holder = ${holder} and fencing_token = ${token}::bigint`;
  }
}
