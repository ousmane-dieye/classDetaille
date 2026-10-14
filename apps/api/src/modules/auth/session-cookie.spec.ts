import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashSessionToken, newSessionToken, sessionClearCookie, sessionSetCookie, STUDENT_SESSION_SECONDS } from './session-cookie.js';

describe('cookie de session (§ 3.4)', () => {
  it('attributs exacts à la pose et à l’effacement', () => {
    expect(sessionSetCookie('TOKEN', STUDENT_SESSION_SECONDS)).toBe('__Host-cp_session=TOKEN; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000');
    expect(sessionClearCookie()).toBe('__Host-cp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  });
  it('jeton de 32 octets ; seul le SHA-256 des octets est stocké', () => {
    const { token, hash } = newSessionToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toEqual(createHash('sha256').update(Buffer.from(token, 'base64url')).digest());
    expect(hashSessionToken(token)).toEqual(hash);
  });
  it('deux jetons ne se répètent pas', () => {
    expect(newSessionToken().token).not.toBe(newSessionToken().token);
  });
  it.each(['', 'abc', 'a'.repeat(44), `${'a'.repeat(42)}!`])('refuse un jeton mal formé %j sans calcul', (t) => {
    expect(hashSessionToken(t)).toBeNull();
  });
});
