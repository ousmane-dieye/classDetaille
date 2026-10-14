import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkerConfig } from '../../config/load-config.js';
import { EmailSender, SENDER_CONTEXT } from './email-sender.js';
import { MailTransport, SmtpMailTransport } from './mail-transport.js';
import { MailModule } from './mail.module.js';
import { PayloadCipher } from './payload-cipher.js';

@Module({})
export class MailWorkerModule {
  static register(config: WorkerConfig, transport?: MailTransport): DynamicModule {
    return {
      module: MailWorkerModule,
      imports: [MailModule.register(config.outboxPayloadKey)],
      providers: [
        { provide: MailTransport, useValue: transport ?? new SmtpMailTransport(config.mail) },
        { provide: SENDER_CONTEXT, useValue: { render: { appOrigin: config.appOrigin }, cipher: new PayloadCipher(config.outboxPayloadKey) } },
        EmailSender,
      ],
      exports: [EmailSender],
    };
  }
}
