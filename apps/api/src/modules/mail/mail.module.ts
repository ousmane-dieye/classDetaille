import { Module, type DynamicModule } from '@nestjs/common';
import { MailDeliveryService } from './mail-delivery.service.js';
import { MailService, OUTBOX_KEY } from './mail.service.js';
import { OutboxRepository } from './outbox.repository.js';

@Module({})
export class MailModule {
  /** Enregistré une fois à la racine, en global : le service mail est transversal (comme Authz/Audit). */
  static register(outboxKey: Buffer): DynamicModule {
    return {
      module: MailModule,
      global: true,
      providers: [{ provide: OUTBOX_KEY, useValue: outboxKey }, OutboxRepository, MailService, MailDeliveryService],
      exports: [MailService, MailDeliveryService],
    };
  }
}
