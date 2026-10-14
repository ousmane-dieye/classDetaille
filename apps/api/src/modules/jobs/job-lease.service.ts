import { Inject, Injectable } from '@nestjs/common';
import type { SystemActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { JobLeaseRepository } from './job-lease.repository.js';

/** Durée 2 min, renouvelée toutes les 30 s (§ 1.4). */
export const LEASE_SECONDS = 120;
export const RENEW_EVERY_MS = 30_000;

/** Le nom du bail est le nom du traitement de l'acteur. */
@Injectable()
export class JobLeaseService {
  constructor(@Inject(AuthzService) private readonly authz: AuthzService, @Inject(JobLeaseRepository) private readonly repo: JobLeaseRepository) {}

  async acquire(actor: SystemActor, holder: string, ttlSeconds = LEASE_SECONDS): Promise<number | null> {
    this.authz.assert(actor, 'jobs.lease');
    return await this.repo.acquire(actor.job, holder, ttlSeconds);
  }

  async renew(actor: SystemActor, holder: string, token: number, ttlSeconds = LEASE_SECONDS): Promise<boolean> {
    this.authz.assert(actor, 'jobs.lease');
    return await this.repo.renew(actor.job, holder, token, ttlSeconds);
  }

  async release(actor: SystemActor, holder: string, token: number): Promise<void> {
    this.authz.assert(actor, 'jobs.lease');
    return await this.repo.release(actor.job, holder, token);
  }
}
