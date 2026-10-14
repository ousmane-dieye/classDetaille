import net from 'node:net';

export type ScriptedSmtpOptions = {
  rcpt?: 'ok' | 450 | 550;
  /** 'silent' : le serveur reçoit les données puis ne répond jamais (délai d'attente de la réponse finale). */
  afterData?: 'accept' | 'drop' | 'silent' | 451 | 554;
  greetingDelayMs?: number;
};

/** Petit serveur SMTP (net) dont les réponses sont scriptées : aucun fournisseur réel dans les tests (R6). */
export async function startScriptedSmtp(opts: ScriptedSmtpOptions = {}) {
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let inData = false;
    let buf = '';
    const reply = (s: string) => socket.write(`${s}\r\n`);
    const t = setTimeout(() => { timers.delete(t); if (!socket.destroyed) reply('220 scripted ESMTP'); }, opts.greetingDelayMs ?? 0);
    timers.add(t);
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          received.push(buf.slice(0, end));
          buf = buf.slice(end + 5);
          inData = false;
          const a = opts.afterData ?? 'accept';
          if (a === 'drop') { socket.destroy(); return; }
          if (a === 'silent') continue;
          reply(a === 'accept' ? '250 2.0.0 OK queued as scripted' : `${a} scripted refusal`);
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') reply('250 scripted');
        else if (cmd === 'MAIL' || cmd === 'RSET') reply('250 OK');
        else if (cmd === 'RCPT') { const r = opts.rcpt ?? 'ok'; reply(r === 'ok' ? '250 OK' : `${r} scripted recipient refusal`); }
        else if (cmd === 'DATA') { inData = true; reply('354 go ahead'); }
        else if (cmd === 'QUIT') { reply('221 bye'); socket.end(); return; }
        else reply('502 not implemented');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, received,
    close: () => new Promise<void>((r) => {
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}
