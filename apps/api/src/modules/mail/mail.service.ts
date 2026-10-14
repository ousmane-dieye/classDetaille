import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { TxClient } from '../../database/prisma.service.js';
import type { Actor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { KIND_SCHEMAS, isSupportedKind, type EmailKind } from './email-kinds.js';
import { OutboxRepository } from './outbox.repository.js';
import { PayloadCipher } from './payload-cipher.js';

export const OUTBOX_KEY = Symbol('OUTBOX_KEY');

export type EnqueueInput = {
  kind: EmailKind; recipientUserId: string; toAddress: string; dedupeKey: string;
  payload: Record<string, unknown>; secret?: Record<string, string>;
  expiresInSeconds?: number; challengeId?: string;
};

@Injectable()
export class MailService {
  private readonly cipher: PayloadCipher;
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(OutboxRepository) private readonly repo: OutboxRepository,
    @Inject(OUTBOX_KEY) key: Buffer,
  ) { this.cipher = new PayloadCipher(key); }

  /** Toujours dans la transaction métier (§ 1.2) ; NOTIFY part au commit (déclencheur). `null` : clé anti-doublon déjà vue. */
  async enqueueInTx(tx: TxClient, actor: Actor, input: EnqueueInput): Promise<string | null> {
    this.authz.assert(actor, 'mail.enqueue');
    if (!isSupportedKind(input.kind)) throw new Error(`email kind ${input.kind} has no template yet`);
    const schemas = KIND_SCHEMAS[input.kind];
    if (!schemas.payload.safeParse(input.payload).success) throw new Error(`invalid payload for ${input.kind}`);
    if (schemas.secret && !schemas.secret.safeParse(input.secret).success) throw new Error(`invalid secret for ${input.kind}`);
    if (!schemas.secret && input.secret) throw new Error(`${input.kind} carries no secret`);
    if (!input.challengeId && input.expiresInSeconds === undefined) throw new Error('an email needs an expiry');
    const id = uuidv7();
    return this.repo.insertInTx(tx, {
      id, kind: input.kind, recipientUserId: input.recipientUserId, toAddress: input.toAddress, dedupeKey: input.dedupeKey,
      payload: input.payload, payloadEncrypted: input.secret ? this.cipher.encrypt(id, input.secret) : null,
      messageId: randomUUID(), challengeId: input.challengeId ?? null, expiresInSeconds: input.expiresInSeconds ?? null,
    });
  }
}
