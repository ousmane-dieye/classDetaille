import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SystemActor } from '../authz/actor.js';
import { isSupportedKind } from './email-kinds.js';
import { MailDeliveryService, type ReservedEmail, type SendResult } from './mail-delivery.service.js';
import { MailTransport } from './mail-transport.js';
import type { PayloadCipher } from './payload-cipher.js';
import { renderEmail, type RenderContext } from './templates.js';

export const SENDER_CONTEXT = Symbol('SENDER_CONTEXT');
export type SenderContext = { render: RenderContext; cipher: PayloadCipher };

/** Un seul email par réservation : à l'arrêt, aucun email réservé mais non envoyé ne reste en SENDING. */
export const RESERVE_BATCH = 1;
/** Bail d'envoi : plus long que le délai total SMTP (R19). */
export const SEND_LEASE_SECONDS = 120;
const SWEEP_LIMIT = 50;
const RENDER_FAILED: SendResult = { kind: 'PERM_FAIL', smtpCode: null, response: null, errorCode: 'RENDER_FAILED' };

@Injectable()
export class EmailSender {
  private readonly logger = new Logger('EmailSender');

  constructor(
    @Inject(MailDeliveryService) private readonly delivery: MailDeliveryService,
    @Inject(MailTransport) private readonly transport: MailTransport,
    @Inject(SENDER_CONTEXT) private readonly ctx: SenderContext,
  ) {}

  /** Balaye les baux expirés, expire les emails en retard, puis envoie ce qui est dû jusqu'à épuisement ou arrêt. */
  async drain(actor: SystemActor, signal: AbortSignal): Promise<number> {
    if (signal.aborted) return 0;
    await this.delivery.sweepExpiredLeases(actor, SWEEP_LIMIT);
    await this.delivery.expireOverdue(actor, SWEEP_LIMIT);
    let processed = 0;
    while (!signal.aborted) {
      const batch = await this.delivery.reserve(actor, RESERVE_BATCH, SEND_LEASE_SECONDS);
      if (batch.length === 0) break;
      for (const row of batch) { await this.deliver(actor, row); processed++; }
    }
    return processed;
  }

  /** `null` : le rendu a échoué (déchiffrement, schéma, type sans modèle) — échec certain, antérieur à toute transmission. */
  private render(row: ReservedEmail): { subject: string; text: string } | null {
    try {
      if (!isSupportedKind(row.kind)) return null;
      const secret = row.payloadEncrypted ? this.ctx.cipher.decrypt(row.id, row.payloadEncrypted) : null;
      return renderEmail(row.kind, row.payload, secret, this.ctx.render);
    } catch {
      return null;
    }
  }

  private async deliver(actor: SystemActor, row: ReservedEmail): Promise<void> {
    // Juste avant l'envoi : la vérification est-elle encore active, la session valide ? (§ 3.3)
    if (row.challengeId && !(await this.delivery.challengeStillActive(actor, row.id))) {
      await this.delivery.cancelSending(actor, row);
      this.logger.log(`email ${row.id} (${row.kind}) cancelled before sending`);
      return;
    }
    const rendered = this.render(row);
    const result = rendered ? await this.transport.send({ messageId: row.messageId, to: row.toAddress, subject: rendered.subject, text: rendered.text }) : RENDER_FAILED;
    // Journal : identifiant, type, catégorie ; jamais l'adresse, le contenu ni la réponse SMTP.
    this.logger.log(`email ${row.id} (${row.kind}) attempt ${row.normalAttempts}${row.retryClaimed ? '+retry' : ''}: ${result.kind}`);
    if (!(await this.delivery.finalize(actor, row, result))) {
      // Annulé en cours d'envoi : seul le code est enregistré. Bail expiré ou réclamation périmée : résultat abandonné (R14).
      await this.delivery.recordLateOutcome(actor, row, result);
      this.logger.warn(`LATE_RESULT_DROPPED ${row.id} ${result.kind}`);
    }
  }
}
