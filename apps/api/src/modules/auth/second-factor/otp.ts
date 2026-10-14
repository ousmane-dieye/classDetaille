import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { CHALLENGE_COOKIE } from '../../../http/session-cookie-name.js';

export const OTP_TTL_SECONDS = 600;
const ATTRS = 'Path=/; Secure; HttpOnly; SameSite=Strict';

/** Aléa cryptographique (randomInt), jamais Math.random. */
export function newOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** HMAC-SHA256(OTP_PEPPER, challenge_id ‖ code) (§ 3.3) ; l'identifiant (36 caractères) est celui de la vérification, fixé avant le calcul. */
export function otpHmac(pepper: string, challengeId: string, code: string): Buffer {
  return createHmac('sha256', pepper).update(challengeId.toLowerCase(), 'utf8').update(code, 'utf8').digest();
}

/** Comparaison à temps constant. */
export function otpMatches(expected: Buffer, pepper: string, challengeId: string, code: string): boolean {
  const actual = otpHmac(pepper, challengeId, code);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function newChallengeToken(): { token: string; hash: Buffer } {
  const raw = randomBytes(32);
  return { token: raw.toString('base64url'), hash: createHash('sha256').update(raw).digest() };
}

/** Jeton mal formé : null, sans requête en base. */
export function hashChallengeToken(token: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  return raw.length === 32 ? createHash('sha256').update(raw).digest() : null;
}

export const challengeSetCookie = (token: string): string => `${CHALLENGE_COOKIE}=${token}; ${ATTRS}; Max-Age=${OTP_TTL_SECONDS}`;
/** Effacement avec exactement les mêmes attributs (§ 3.3). */
export const challengeClearCookie = (): string => `${CHALLENGE_COOKIE}=; ${ATTRS}; Max-Age=0`;
