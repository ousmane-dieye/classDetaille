import { createHash, randomBytes } from 'node:crypto';
import { SESSION_COOKIE } from '../../http/session-cookie-name.js';

/** Étudiant : Max-Age de 30 jours, fixé à la connexion (§ 3.4) ; inactivité = même durée (R4). */
export const STUDENT_SESSION_SECONDS = 30 * 24 * 3600;
const ATTRS = 'Path=/; Secure; HttpOnly; SameSite=Lax';

export function newSessionToken(): { token: string; hash: Buffer } {
  const raw = randomBytes(32);
  return { token: raw.toString('base64url'), hash: createHash('sha256').update(raw).digest() };
}

/** Jeton mal formé : null, sans requête en base. */
export function hashSessionToken(token: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  return raw.length === 32 ? createHash('sha256').update(raw).digest() : null;
}

export function sessionSetCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; ${ATTRS}; Max-Age=${maxAgeSeconds}`;
}

/** Effacement avec exactement les mêmes attributs (§ 3.4). */
export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; ${ATTRS}; Max-Age=0`;
}
