export class CliError extends Error {
  constructor(readonly code: string) { super(code); }
}

type In = NodeJS.ReadStream & { isTTY?: boolean };

function promptHidden(stdin: In, out: NodeJS.WritableStream, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => { stdin.off('data', onData); stdin.setRawMode?.(false); stdin.pause(); out.write('\n'); };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { cleanup(); resolve(value); return; }
        if (ch === '\u0003') { cleanup(); reject(new CliError('CANCELLED')); return; }
        if (ch === '\u007f' || ch === '\b') { value = [...value].slice(0, -1).join(''); continue; }
        value += ch;
      }
    };
    out.write(label);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Mot de passe lu sur l'entrée standard (§ 3.2), jamais en argument ni en variable d'environnement. */
export async function readPassword(stdin: In = process.stdin, out: NodeJS.WritableStream = process.stderr): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  }
  const first = await promptHidden(stdin, out, 'Mot de passe : ');
  const second = await promptHidden(stdin, out, 'Confirme le mot de passe : ');
  if (first !== second) throw new CliError('PASSWORDS_DO_NOT_MATCH');
  return first;
}
