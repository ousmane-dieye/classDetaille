import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { RECOVERY_ALPHABET, RECOVERY_CODE_LENGTH, isAcceptedEmail, normalizeEmail } from '@classepulse/shared';
import { otpHmac } from '../modules/auth/second-factor/otp.js';

export type RecoveryIo = { isTty: boolean; write(s: string): void; waitForEnter(): Promise<void> };

/** 12 caractères de l'alphabet sans ambiguïté (R15) ; `crypto.randomInt` est uniforme. */
export function newRecoveryCode(): string {
  let c = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) c += RECOVERY_ALPHABET[randomInt(0, RECOVERY_ALPHABET.length)]!;
  return c;
}
const grouped = (c: string): string => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;

/** Seule la catégorie de l'erreur est affichée : jamais de message, de trace ni de valeur (§ 3.3). */
function category(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'P0002') return 'TARGET_NOT_ACTIVE_ADMIN';
  if (code === 'P0003') return 'TARGET_BLOCKED (compte bloqué : relancer avec --clear-block)';
  return 'UNEXPECTED';
}

/**
 * `ops admin-recovery-code` (§ 3.3). Le code est généré ici ; PostgreSQL ne reçoit que son HMAC, en paramètres liés
 * (texte SQL constant). Affiché seulement après la validation, puis l'écran est effacé. Aucune dépendance applicative, aucun journal.
 */
export async function runAdminRecoveryCode(
  deps: { client: Pick<pg.Client, 'query'>; pepper: string; io: RecoveryIo },
  args: { email: string; clearBlock: boolean },
): Promise<number> {
  const { client, pepper, io } = deps;
  // Garde-fou, pas une garantie (§ 3.3).
  if (!io.isTty) { io.write('erreur : TTY_REQUIRED (lance la commande depuis un terminal)\n'); return 2; }
  const email = normalizeEmail(args.email);
  if (!isAcceptedEmail(email)) { io.write('erreur : INVALID_ARGUMENTS\n'); return 2; }
  const code = newRecoveryCode();
  const challengeId = uuidv7();
  try {
    // Appel autocommit : la fonction est validée quand la promesse est résolue.
    await client.query('select priv.issue_admin_recovery_code($1, $2, $3, $4) as expires_at', [email, challengeId, otpHmac(pepper, challengeId, code), args.clearBlock]);
  } catch (e) {
    io.write(`erreur : ${category(e)}\n`);
    return 1;
  }
  io.write(`Code de récupération (valable 15 minutes, à transmettre par un canal sûr) : ${grouped(code)}\n`);
  io.write('Appuie sur Entrée pour effacer l’écran.\n');
  try { await io.waitForEnter(); } finally { io.write('\x1b[2J\x1b[3J\x1b[H'); }
  return 0;
}
