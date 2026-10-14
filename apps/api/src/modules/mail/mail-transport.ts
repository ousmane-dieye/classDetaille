import nodemailer, { type Transporter } from 'nodemailer';
import type { WorkerConfig } from '../../config/load-config.js';
import type { SendResult } from './outbox.repository.js';

export type OutgoingMail = { messageId: string; to: string; subject: string; text: string };

export abstract class MailTransport {
  abstract send(mail: OutgoingMail): Promise<SendResult>;
}

/** Commandes nommées par nodemailer avant la transmission des données (§ 2.4). « CONN » est traité à part. */
const BEFORE_DATA = new Set(['EHLO', 'HELO', 'LHLO', 'STARTTLS', 'AUTH', 'AUTH PLAIN', 'AUTH LOGIN', 'AUTH CRAM-MD5', 'AUTH XOAUTH2', 'MAIL FROM', 'RCPT TO']);
/** Codes réseau de nodemailer 10.1.0 (errors.js) pour une panne de connexion. */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET', 'EDNS', 'ETLS']);
/**
 * nodemailer 10.1.0 rapporte toute panne de socket avec command « CONN », même en pleine transmission des données :
 * « CONN » ne prouve donc rien. Ne sont certaines que les pannes qui ne peuvent survenir qu'à l'établissement :
 * erreur système de connexion (originalCode) ou délai de connexion, de salutation ou de mise à niveau TLS (timeoutType).
 * SOCKET_TIMEOUT (inactivité) et la fermeture de connexion sans réponse peuvent survenir après le point final : ambigus.
 */
const CONNECT_ONLY_SYSTEM_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const CONNECT_ONLY_TIMEOUTS = new Set(['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT']);
const SESSION_COMMANDS = new Set(['CONN', 'EHLO', 'HELO', 'LHLO', 'STARTTLS']);

const clip = (s: unknown): string | null => (typeof s === 'string' ? s.slice(0, 200) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * En cas de doute, AMBIGUOUS. Sont certains : une réponse SMTP explicite (4xx = non accepté, temporaire ; 5xx = refusé),
 * une erreur d'authentification, et une panne survenue avant la commande DATA (voir les tables ci-dessus).
 * Aucun message d'erreur n'est conservé (il peut citer l'hôte ou l'identifiant) : seuls le code et la réponse tronquée le sont.
 */
export function classifySmtpError(e: unknown): SendResult {
  const err = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
  const code = str(err['code']);
  const originalCode = str(err['originalCode']);
  const timeoutType = str(err['timeoutType']);
  const command = str(err['command']);
  const smtpCode = typeof err['responseCode'] === 'number' ? err['responseCode'] : null;
  const base = { smtpCode, response: clip(err['response']), errorCode: code };
  if (code === 'EAUTH') return { ...base, kind: 'TEMP_FAIL' }; // configuration : on réessaie, l'opérateur peut corriger
  if (smtpCode !== null) {
    if (smtpCode >= 400 && smtpCode < 500) return { ...base, kind: 'TEMP_FAIL' };
    if (smtpCode >= 500 && smtpCode < 600) {
      // Un 5xx au niveau de la session (salutation, EHLO, STARTTLS) vise le serveur, pas ce message : on réessaiera.
      return { ...base, kind: command !== null && SESSION_COMMANDS.has(command) ? 'TEMP_FAIL' : 'PERM_FAIL' };
    }
    return { ...base, kind: 'AMBIGUOUS' };
  }
  if (code !== null && NETWORK_CODES.has(code)) {
    if (command !== null && BEFORE_DATA.has(command)) return { ...base, kind: 'TEMP_FAIL' };
    if (command === 'CONN') {
      const connectOnly = (originalCode !== null && CONNECT_ONLY_SYSTEM_CODES.has(originalCode)) || CONNECT_ONLY_SYSTEM_CODES.has(code)
        || (timeoutType !== null && CONNECT_ONLY_TIMEOUTS.has(timeoutType)) || code === 'EDNS';
      if (connectOnly) return { ...base, kind: 'TEMP_FAIL' };
    }
  }
  return { ...base, kind: 'AMBIGUOUS' };
}

export class SmtpMailTransport extends MailTransport {
  private readonly transporter: Transporter;
  private readonly domain: string;

  constructor(private readonly mail: WorkerConfig['mail']) {
    super();
    const s = mail.smtp;
    this.domain = mail.from.split('@')[1]!;
    this.transporter = nodemailer.createTransport({
      host: s.host, port: s.port,
      secure: s.security === 'tls', requireTLS: s.security === 'starttls', ignoreTLS: s.security === 'none',
      ...(s.auth ? { auth: { user: s.auth.user, pass: s.auth.password } } : {}),
      // socketTimeout > greetingTimeout : sinon le délai d'inactivité du socket (ambigu) devance celui de la salutation (certain).
      connectionTimeout: s.timeoutMs, greetingTimeout: s.timeoutMs, socketTimeout: s.timeoutMs + 500,
    });
  }

  async send(m: OutgoingMail): Promise<SendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: { name: 'ClassePulse', address: this.mail.from },
        to: m.to, subject: m.subject, text: m.text,
        messageId: `<${m.messageId}@${this.domain}>`,
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
      const response = String(info.response ?? '');
      // ACCEPTED = réponse 250 du serveur configuré (§ 2.4). Toute autre forme de succès apparent est un doute.
      if (/^250[ -]/.test(response) && info.accepted?.length === 1) return { kind: 'ACCEPTED', smtpCode: 250, response: clip(response), errorCode: null };
      return { kind: 'AMBIGUOUS', smtpCode: null, response: clip(response), errorCode: 'UNEXPECTED_RESPONSE' };
    } catch (e) {
      return classifySmtpError(e);
    }
  }
}
