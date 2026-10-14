import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

@Injectable()
export class MaintenanceRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Même colonne de fenêtre que le limiteur (`window_start` plus récent que maintenant moins la fenêtre = vivant) :
   * seuls les seaux strictement plus vieux que `olderThanSeconds` (>= la plus longue fenêtre) sont supprimés.
   * Une ligne verrouillée par une transaction ouverte est ignorée (SKIP LOCKED) : jamais d'attente.
   * Le prédicat est répété sur le DELETE : une ligne renouvelée entre-temps n'est pas supprimée.
   */
  async purgeRateLimitBucketsBatch(olderThanSeconds: number, batch: number): Promise<number> {
    const r = await this.prisma.client.$queryRaw<{ key: string }[]>`
      with d as (
        select key from app.rate_limit_buckets
         where window_start < clock_timestamp() - make_interval(secs => ${olderThanSeconds}::double precision)
         limit ${batch}::int for update skip locked)
      delete from app.rate_limit_buckets b using d
       where b.key = d.key and b.window_start < clock_timestamp() - make_interval(secs => ${olderThanSeconds}::double precision)
      returning b.key`;
    return r.length;
  }
}
