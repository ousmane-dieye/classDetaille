import { parseArgs } from 'node:util';
import readline from 'node:readline';
import pg from 'pg';
import { toPgPoolConfig } from './config/database-connection.js';
import { loadOpsConfig } from './config/load-config.js';
import { runAdminRecoveryCode, type RecoveryIo } from './ops/admin-recovery-code.js';

const USAGE = 'usage : ops admin-recovery-code --email <email> [--clear-block]\n';

const terminalIo = (): RecoveryIo => ({
  isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  write: (s) => { process.stdout.write(s); },
  waitForEnter: () => new Promise<void>((done) => { const rl = readline.createInterface({ input: process.stdin }); rl.question('', () => { rl.close(); done(); }); }),
});

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'admin-recovery-code') { process.stderr.write(USAGE); return 2; }
  const io = terminalIo();
  if (!io.isTty) { process.stderr.write('erreur : TTY_REQUIRED (lance la commande depuis un terminal)\n'); return 2; }
  let parsed: { email?: string; 'clear-block'?: boolean };
  try {
    parsed = parseArgs({ args: rest, strict: true, options: { email: { type: 'string' }, 'clear-block': { type: 'boolean' } } }).values;
  } catch { process.stderr.write(USAGE); return 2; }
  if (!parsed.email) { process.stderr.write(USAGE); return 2; }
  let config: ReturnType<typeof loadOpsConfig>;
  try { config = loadOpsConfig(process.env); } catch (e) {
    process.stderr.write(`erreur : INVALID_CONFIGURATION\n${e instanceof Error ? e.message : ''}\n`);
    return 1;
  }
  const client = new pg.Client(toPgPoolConfig(config.db));
  try {
    await client.connect();
    return await runAdminRecoveryCode({ client, pepper: config.otpPepper, io }, { email: parsed.email, clearBlock: parsed['clear-block'] === true });
  } catch { process.stderr.write('erreur : UNEXPECTED\n'); return 1; } finally { await client.end().catch(() => undefined); }
}

main(process.argv.slice(2)).then((code) => { process.exit(code); });
