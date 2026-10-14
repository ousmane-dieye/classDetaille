import { Inject, Injectable } from '@nestjs/common';
import type { SystemActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { nextState } from './outbox-policy.js';
import { OutboxRepository, type ReservedEmail, type SendResult } from './outbox.repository.js';

export type { ReservedEmail, SendResult };

/** Côté worker : toutes les opérations exigent l'acteur système (R1). */
@Injectable()
export class MailDeliveryService {
  constructor(@Inject(AuthzService) private readonly authz: AuthzService, @Inject(OutboxRepository) private readonly repo: OutboxRepository) {}

  async reserve(actor: SystemActor, batch: number, leaseSeconds: number): Promise<ReservedEmail[]> {
    this.authz.assert(actor, 'mail.deliver');
    return await this.repo.reserve(batch, leaseSeconds);
  }

  async finalize(actor: SystemActor, row: ReservedEmail, result: SendResult): Promise<boolean> {
    this.authz.assert(actor, 'mail.deliver');
    return await this.repo.finalize(row, nextState({ normalAttempts: row.normalAttempts, retryClaimed: row.retryClaimed }, result.kind), result);
  }

  async recordLateOutcome(actor: SystemActor, row: ReservedEmail, result: SendResult): Promise<void> {
    this.authz.assert(actor, 'mail.deliver');
    return await this.repo.recordLateOutcome(row, result);
  }

  async challengeStillActive(actor: SystemActor, emailId: string): Promise<boolean> {
    this.authz.assert(actor, 'mail.deliver');
    return await this.repo.challengeStillActive(emailId);
  }

  async cancelSending(actor: SystemActor, row: ReservedEmail): Promise<boolean> {
    this.authz.assert(actor, 'mail.deliver');
    return await this.repo.cancelSending(row);
  }

  async sweepExpiredLeases(actor: SystemActor, limit: number): Promise<number> {
    this.authz.assert(actor, 'mail.sweep');
    return await this.repo.sweepExpiredLeases(limit);
  }

  async expireOverdue(actor: SystemActor, limit: number): Promise<number> {
    this.authz.assert(actor, 'mail.sweep');
    return await this.repo.expireOverdue(limit);
  }
}
