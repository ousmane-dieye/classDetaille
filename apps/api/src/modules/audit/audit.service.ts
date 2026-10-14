import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { TxClient } from '../../database/prisma.service.js';
import type { Actor } from '../authz/actor.js';
import { AUDIT_METADATA, AUDIT_METADATA_MAX_BYTES, type AppAuditAction, type AuditTargetType } from './audit-actions.js';
import { AuditRepository } from './audit.repository.js';

export type AuditEntry<A extends AppAuditAction> = {
  action: A;
  targetType?: AuditTargetType;
  targetId?: string;
  metadata: z.input<(typeof AUDIT_METADATA)[A]>;
};

@Injectable()
export class AuditService {
  constructor(@Inject(AuditRepository) private readonly repo: AuditRepository) {}

  /** Toujours dans la transaction de l'action journalisée (§ 1.2, règle 3). */
  async recordInTx<A extends AppAuditAction>(tx: TxClient, actor: Actor, entry: AuditEntry<A>): Promise<void> {
    const parsed = AUDIT_METADATA[entry.action].safeParse(entry.metadata);
    if (!parsed.success) throw new Error(`audit metadata rejected for ${entry.action}`);
    const metadata = parsed.data as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(metadata)) > AUDIT_METADATA_MAX_BYTES) throw new Error('audit metadata too large');
    if ((entry.targetType === undefined) !== (entry.targetId === undefined)) throw new Error('audit target incomplete');
    await this.repo.insertInTx(tx, {
      actorUserId: actor.kind === 'user' ? actor.userId : null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata,
    });
  }
}
