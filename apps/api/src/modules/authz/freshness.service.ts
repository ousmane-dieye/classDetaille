import { Inject, Injectable } from '@nestjs/common';
import type { TxClient } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import type { UserActor } from './actor.js';
import { AuthzService } from './authz.service.js';

/**
 * Fraîcheur de la ressaisie du mot de passe et du code (§ 3.3 : fenêtre de 5 minutes).
 * Vit dans AuthzModule — déjà global et déjà présent dans tous les contextes (API, CLI) — car les
 * modules métier (retrait, délégation, archivage, transfert) doivent l'appeler sans importer
 * AuthModule, qui eux-mêmes les importent : un tel cycle serait invalide.
 */
@Injectable()
export class FreshnessService {
  constructor(@Inject(AuthzService) private readonly authz: AuthzService) {}

  /** Pour les actions sensibles : ressaisie du mot de passe datant de moins de 5 min. Dans la transaction de l'action. */
  async assertRecentPasswordInTx(tx: TxClient, actor: UserActor): Promise<void> {
    this.authz.assert(actor, 'reauth.assertRecent');
    const f = await this.freshnessInTx(tx, actor.sessionId);
    if (!f) throw new ApiError(401, 'UNAUTHENTICATED');
    if (!f.password) throw new ApiError(403, 'REAUTH_REQUIRED');
  }

  /** Vérification complète (mot de passe + code) : promotion, suspension, anonymisation, archivage, transfert en masse. */
  async assertStepUpFreshInTx(tx: TxClient, actor: UserActor): Promise<void> {
    this.authz.assert(actor, 'stepUp.assertFresh');
    const f = await this.freshnessInTx(tx, actor.sessionId);
    if (!f) throw new ApiError(401, 'UNAUTHENTICATED');
    if (!f.password) throw new ApiError(403, 'STEP_UP_REQUIRED', { missing: 'PASSWORD' });
    if (!f.code) throw new ApiError(403, 'STEP_UP_REQUIRED', { missing: 'CODE' });
  }

  /** Fraîcheur (moins de 5 min) sous `FOR SHARE` : la session ne peut pas être révoquée pendant l'action. `null` : session invalide. */
  private async freshnessInTx(tx: TxClient, sessionId: string): Promise<{ password: boolean; code: boolean } | null> {
    const r = await tx.$queryRaw<{ pw: boolean; code: boolean }[]>`
      select coalesce(reauth_at > clock_timestamp() - interval '5 minutes', false) as pw,
             coalesce(step_up_at > clock_timestamp() - interval '5 minutes', false) as code
        from app.sessions
       where id = ${sessionId}::uuid and revoked_at is null and idle_expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()
         for share`;
    return r[0] ? { password: r[0].pw, code: r[0].code } : null;
  }
}
