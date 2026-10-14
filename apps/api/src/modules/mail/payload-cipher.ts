import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM ; données additionnelles authentifiées = identifiant de l'email (R13). Format : IV ‖ étiquette ‖ chiffré. */
export class PayloadCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('OUTBOX_PAYLOAD_KEY must be 32 bytes');
  }

  encrypt(emailId: string, secret: Record<string, string>): Buffer {
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(emailId, 'utf8'));
    const ct = Buffer.concat([c.update(JSON.stringify(secret), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  /** Toute erreur est remplacée par un message constant : ni contenu, ni clé, ni détail du moteur. */
  decrypt(emailId: string, data: Buffer): Record<string, string> {
    try {
      if (data.length < IV_BYTES + TAG_BYTES) throw new Error('short');
      const d = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
      d.setAAD(Buffer.from(emailId, 'utf8'));
      d.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([d.update(data.subarray(IV_BYTES + TAG_BYTES)), d.final()]);
      return JSON.parse(plain.toString('utf8')) as Record<string, string>;
    } catch {
      throw new Error('payload decryption failed');
    }
  }
}
