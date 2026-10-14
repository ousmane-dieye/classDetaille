import { describe, expect, it } from 'vitest';
import { classifySmtpError } from './mail-transport.js';

/** « En cas de doute, ambigu » (§ 2.4) : seuls les échecs d'étape connue et antérieure aux données sont certains. */
describe('classifySmtpError', () => {
  it.each([
    // Formes réelles de nodemailer 10.1.0 : les erreurs de socket portent command « CONN » quelle que soit l'étape.
    [{ code: 'ESOCKET', originalCode: 'ECONNREFUSED', command: 'CONN' }, 'TEMP_FAIL'],
    [{ code: 'EDNS', originalCode: 'ENOTFOUND', command: 'CONN' }, 'TEMP_FAIL'],
    [{ code: 'ETIMEDOUT', timeoutType: 'CONNECT_TIMEOUT', command: 'CONN' }, 'TEMP_FAIL'],
    [{ code: 'ETIMEDOUT', timeoutType: 'GREETING_TIMEOUT', command: 'CONN' }, 'TEMP_FAIL'],
    [{ code: 'ETIMEDOUT', timeoutType: 'UPGRADE_TIMEOUT', command: 'CONN' }, 'TEMP_FAIL'],
    [{ code: 'ETLS', command: 'STARTTLS' }, 'TEMP_FAIL'],
    [{ code: 'ESOCKET', command: 'EHLO' }, 'TEMP_FAIL'],
    [{ code: 'ECONNECTION', command: 'RCPT TO' }, 'TEMP_FAIL'],
    [{ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }, 'TEMP_FAIL'],
    [{ code: 'ECONNECTION', responseCode: 421, command: 'CONN' }, 'TEMP_FAIL'],
    [{ responseCode: 450, command: 'RCPT TO' }, 'TEMP_FAIL'],
    [{ responseCode: 451, command: 'DATA' }, 'TEMP_FAIL'],
    [{ responseCode: 550, command: 'RCPT TO' }, 'PERM_FAIL'],
    [{ responseCode: 554, command: 'DATA' }, 'PERM_FAIL'],
    [{ code: 'EPROTOCOL', responseCode: 554, command: 'CONN' }, 'TEMP_FAIL'], // refus au niveau du serveur, pas du destinataire
    // Tout ce qui a pu atteindre le serveur après DATA, ou dont l'étape est inconnue, est ambigu.
    [{ code: 'ETIMEDOUT', timeoutType: 'SOCKET_TIMEOUT', command: 'CONN' }, 'AMBIGUOUS'],
    [{ code: 'ETIMEDOUT', command: 'CONN' }, 'AMBIGUOUS'],
    [{ code: 'ESOCKET', originalCode: 'ECONNRESET', command: 'CONN' }, 'AMBIGUOUS'],
    [{ code: 'ECONNECTION', command: 'CONN' }, 'AMBIGUOUS'],
    [{ code: 'ETIMEDOUT', command: 'DATA' }, 'AMBIGUOUS'],
    [{ code: 'ECONNRESET', command: 'DATA' }, 'AMBIGUOUS'],
    [{ code: 'ESOCKET' }, 'AMBIGUOUS'],
    [{ code: 'ECONNECTION', command: 'DATA' }, 'AMBIGUOUS'],
    [{ code: 'EENVELOPE', command: 'API' }, 'AMBIGUOUS'],
    [new Error('inconnu'), 'AMBIGUOUS'],
    ['une chaîne', 'AMBIGUOUS'],
    [null, 'AMBIGUOUS'],
  ])('%j → %s', (err, expected) => {
    expect(classifySmtpError(err).kind).toBe(expected);
  });
  it('conserve le code SMTP et tronque la réponse', () => {
    const r = classifySmtpError({ responseCode: 550, response: `550 ${'x'.repeat(400)}`, command: 'RCPT TO' });
    expect(r.smtpCode).toBe(550);
    expect(r.response!.length).toBeLessThanOrEqual(200);
  });
});
