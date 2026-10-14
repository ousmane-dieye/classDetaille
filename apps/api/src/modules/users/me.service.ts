import { Inject, Injectable } from '@nestjs/common';
import type { UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { ClassesService } from '../classes/classes.service.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import type { MeDto } from './me.dto.js';
import { UsersService } from './users.service.js';

const REFUSAL_RETRY_MS = 24 * 3600 * 1000;

/** Vue « moi » : profil + dernière demande d'adhésion (écrans d'état, UX § 1.1). */
@Injectable()
export class MeService {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(MembershipsService) private readonly memberships: MembershipsService,
    @Inject(ClassesService) private readonly classes: ClassesService,
  ) {}

  async me(actor: UserActor): Promise<MeDto> {
    this.authz.assert(actor, 'me.read');
    const profile = await this.users.profileOf(actor);
    const req = actor.globalRole === 'USER' ? await this.memberships.latestRequestOf(actor) : null;
    if (!req) return { ...profile, enrollment: null };
    return {
      ...profile,
      enrollment: {
        id: req.id,
        status: req.status,
        class: await this.classes.summaryOf(actor, req.classId),
        createdAt: req.createdAt.toISOString(),
        decidedAt: req.decidedAt?.toISOString() ?? null,
        decisionNote: req.decisionNote,
        retryAfter: req.status === 'REFUSED' && req.decidedAt ? new Date(req.decidedAt.getTime() + REFUSAL_RETRY_MS).toISOString() : null,
      },
    };
  }
}
