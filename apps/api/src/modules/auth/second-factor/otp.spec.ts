import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { challengeClearCookie, challengeSetCookie, hashChallengeToken, newChallengeToken, newOtpCode, otpHmac, otpMatches } from './otp.js';

const ID = '0199c0de-0000-7000-8000-000000000001';
describe('codes (§ 3.3)', () => {
  it('6 chiffres, zéros initiaux conservés', () => {
    for (let i = 0; i < 2000; i++) expect(newOtpCode()).toMatch(/^[0-9]{6}$/);
  });
  it('le HMAC suit la spec : HMAC-SHA256(pepper, identifiant ‖ code), calculé ici indépendamment', () => {
    const expected = createHmac('sha256', 'pepper-de-test').update(Buffer.from(`${ID}123456`, 'utf8')).digest();
    expect(otpHmac('pepper-de-test', ID, '123456').equals(expected)).toBe(true);
  });
  it('otpMatches : bon code, mauvais code, autre identifiant, autre pepper, longueur différente', () => {
    const h = otpHmac('p'.repeat(40), ID, '123456');
    expect(otpMatches(h, 'p'.repeat(40), ID, '123456')).toBe(true);
    expect(otpMatches(h, 'p'.repeat(40), ID, '123457')).toBe(false);
    expect(otpMatches(h, 'p'.repeat(40), '0199c0de-0000-7000-8000-000000000002', '123456')).toBe(false);
    expect(otpMatches(h, 'q'.repeat(40), ID, '123456')).toBe(false);
    expect(otpMatches(h.subarray(0, 16), 'p'.repeat(40), ID, '123456')).toBe(false);
  });
  it('le jeton de vérification : 32 octets, seul le SHA-256 est stocké, un jeton mal formé est refusé sans calcul', () => {
    const { token, hash } = newChallengeToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashChallengeToken(token)!.equals(hash)).toBe(true);
    expect(hashChallengeToken('court')).toBeNull();
    expect(hashChallengeToken('!'.repeat(43))).toBeNull();
  });
  it('cookie : attributs exacts (§ 3.3), effacement avec les mêmes attributs', () => {
    const t = 'A'.repeat(43);
    expect(challengeSetCookie(t)).toBe(`__Host-cp_challenge=${t}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`);
    expect(challengeClearCookie()).toBe('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
  });
});
