import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { TxClient } from '../../database/prisma.service.js';
import type { AnonymousActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import type { EnrollmentRow } from './enrollment.dto.js';
import { MembershipsRepository } from './memberships.repository.js';

@Injectable()
export class MembershipsService {
  constructor(@Inject(MembershipsRepository) private readonly repo: MembershipsRepository, @Inject(AuthzService) private readonly authz: AuthzService) {}

  /** Demande d'adhésion créée dans la transaction de l'inscription (§ 0.3). */
  async createRequestInTx(tx: TxClient, actor: AnonymousActor, input: { userId: string; classId: string }): Promise<string> {
    this.authz.assert(actor, 'auth.register');
    const id = uuidv7();
    await this.repo.createRequestInTx(tx, { id, ...input });
    return id;
  }

  async latestRequestOf(actor: UserActor): Promise<EnrollmentRow | null> {
    this.authz.assert(actor, 'me.read');
    return this.repo.latestForUser(actor.userId);
  }
}
