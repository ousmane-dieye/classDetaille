import { Inject, Injectable } from '@nestjs/common';
import type { SystemActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { MaintenanceRepository } from './maintenance.repository.js';

/** R18 : la plus longue fenêtre de seau est 1 h ; on garde 2 h. */
export const BUCKET_RETENTION_SECONDS = 7200;
export const PURGE_BATCH = 5000;

@Injectable()
export class MaintenanceService {
  constructor(@Inject(AuthzService) private readonly authz: AuthzService, @Inject(MaintenanceRepository) private readonly repo: MaintenanceRepository) {}

  /** Par lots ; s'arrête entre deux lots si `signal` est annulé (arrêt, bail perdu). */
  async purgeRateLimitBuckets(actor: SystemActor, olderThanSeconds = BUCKET_RETENTION_SECONDS, batch = PURGE_BATCH, signal?: AbortSignal): Promise<number> {
    this.authz.assert(actor, 'maintenance.purge');
    let total = 0;
    while (!signal?.aborted) {
      const n = await this.repo.purgeRateLimitBucketsBatch(olderThanSeconds, batch);
      total += n;
      if (n < batch) break;
    }
    return total;
  }
}
