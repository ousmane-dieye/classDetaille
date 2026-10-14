import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SmtpMailTransport } from '../../src/modules/mail/mail-transport.js';
import { startScriptedSmtp, type ScriptedSmtpOptions } from '../support/scripted-smtp.js';

const mail = () => ({ messageId: randomUUID(), to: 'dest@example.com', subject: 'Sujet', text: 'Corps du message' });
const cfg = (port: number, timeoutMs = 3000) => ({ from: 'no-reply@app.test', smtp: { host: '127.0.0.1', port, security: 'none' as const, auth: null, timeoutMs } });

async function sendWith(opts: ScriptedSmtpOptions, timeoutMs?: number) {
  const s = await startScriptedSmtp(opts);
  try { return { result: await new SmtpMailTransport(cfg(s.port, timeoutMs)).send(mail()), received: s.received }; } finally { await s.close(); }
}

describe('SmtpMailTransport sur le fil (serveur scripté)', () => {
  it('250 : ACCEPTED, avec le Message-ID composé par le worker (R12)', async () => {
    const m = mail();
    const s = await startScriptedSmtp();
    try {
      const r = await new SmtpMailTransport(cfg(s.port)).send(m);
      expect(r).toMatchObject({ kind: 'ACCEPTED', smtpCode: 250 });
      expect(s.received[0]).toContain(`Message-ID: <${m.messageId}@app.test>`);
      expect(s.received[0]).toContain('Corps du message');
    } finally { await s.close(); }
  });
  it('450 au destinataire : TEMP_FAIL certain', async () => { expect((await sendWith({ rcpt: 450 })).result.kind).toBe('TEMP_FAIL'); });
  it('550 au destinataire : PERM_FAIL', async () => { expect((await sendWith({ rcpt: 550 })).result).toMatchObject({ kind: 'PERM_FAIL', smtpCode: 550 }); });
  it('451 après les données : refus explicite, TEMP_FAIL', async () => { expect((await sendWith({ afterData: 451 })).result.kind).toBe('TEMP_FAIL'); });
  it('554 après les données : PERM_FAIL', async () => { expect((await sendWith({ afterData: 554 })).result.kind).toBe('PERM_FAIL'); });
  it('connexion coupée après les données : AMBIGUOUS (le message a peut-être été accepté)', async () => {
    const { result, received } = await sendWith({ afterData: 'drop' });
    expect(received).toHaveLength(1);
    expect(result.kind).toBe('AMBIGUOUS');
  });
  it('aucune réponse finale (délai d’attente après les données) : AMBIGUOUS', async () => {
    const { result, received } = await sendWith({ afterData: 'silent' }, 800);
    expect(received).toHaveLength(1);
    expect(result.kind).toBe('AMBIGUOUS');
  });
  it('port fermé : TEMP_FAIL certain (rien n’a été transmis)', async () => {
    const s = await startScriptedSmtp();
    const port = s.port;
    await s.close();
    expect((await new SmtpMailTransport(cfg(port)).send(mail())).kind).toBe('TEMP_FAIL');
  });
  it('salutation qui n’arrive jamais : TEMP_FAIL certain', async () => {
    expect((await sendWith({ greetingDelayMs: 5000 }, 1000)).result.kind).toBe('TEMP_FAIL');
  });
});
