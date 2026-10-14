import { Injectable } from '@nestjs/common';
import type { TxClient } from '../../database/prisma.service.js';
import type { AppAuditAction, AuditTargetType } from './audit-actions.js';

export type AuditRow = {
  actorUserId: string | null;
  action: AppAuditAction;
  targetType: AuditTargetType | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
};

@Injectable()
export class AuditRepository {
  async insertInTx(tx: TxClient, row: AuditRow): Promise<void> {
    // Requête SQL explicite : cp_app n'a le droit d'insérer que ces cinq colonnes. Le client Prisma enverrait
    // aussi occurred_at et source (valeurs par défaut calculées côté client), refusés par les droits par colonne.
    // source, occurred_at et db_login_role sont posés par le trigger audit_log_guard.
    await tx.$executeRaw`
      INSERT INTO app.audit_log (actor_user_id, action, target_type, target_id, metadata)
      VALUES (${row.actorUserId}::uuid, ${row.action}::app.audit_action, ${row.targetType}, ${row.targetId}::uuid, ${JSON.stringify(row.metadata)}::jsonb)`;
  }
}
