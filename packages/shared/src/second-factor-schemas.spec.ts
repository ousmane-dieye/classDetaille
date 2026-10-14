import { describe, expect, it } from 'vitest';
import {
  EmailChangeStartBody, ForgotPasswordBody, PasswordBody, RECOVERY_ALPHABET, ResetPasswordBody,
  VerifyCodeBody, VerifyRecoveryBody, normalizeRecoveryCode,
} from './second-factor-schemas.js';

describe('VerifyCodeBody (Review Focus 1)', () => {
  it.each([['123456', '123456'], [' 123 456 ', '123456'], ['123-456', '123456'], ['123456\n', '123456']])('accepte %j', (input, expected) => {
    expect(VerifyCodeBody.parse({ code: input }).code).toBe(expected);
  });
  it.each(['12345', '1234567', 'abcdef', '12 34 5a', '', '１２３４５６'])('refuse %j', (input) => {
    expect(VerifyCodeBody.safeParse({ code: input }).success).toBe(false);
  });
  it('refuse un champ inconnu', () => {
    expect(VerifyCodeBody.safeParse({ code: '123456', extra: 1 }).success).toBe(false);
  });
});

describe('code de récupération (R15)', () => {
  it('l’alphabet a 31 symboles sans I, L, O, 0, 1', () => {
    expect(RECOVERY_ALPHABET).toHaveLength(31);
    for (const c of 'ILO01') expect(RECOVERY_ALPHABET).not.toContain(c);
  });
  it.each([['abcd-efgh-jkmn', 'ABCDEFGHJKMN'], [' ABCD EFGH JKMN ', 'ABCDEFGHJKMN']])('normalise %j', (input, expected) => {
    expect(normalizeRecoveryCode(input)).toBe(expected);
    expect(VerifyRecoveryBody.parse({ recoveryCode: input }).recoveryCode).toBe(expected);
  });
  it.each(['ABCDEFGHJKM', 'ABCDEFGHJKMNP', 'ABCDEFGHIKMN', 'ABCDEFGHJK0N'])('refuse %j', (input) => {
    expect(VerifyRecoveryBody.safeParse({ recoveryCode: input }).success).toBe(false);
  });
});

describe('autres corps', () => {
  it('ForgotPasswordBody normalise l’email et exige Turnstile', () => {
    expect(ForgotPasswordBody.parse({ email: ' Awa@Example.COM ', turnstileToken: 't' }).email).toBe('awa@example.com');
    expect(ForgotPasswordBody.safeParse({ email: 'awa@example.com' }).success).toBe(false);
  });
  it('ResetPasswordBody exige un jeton de 43 caractères base64url', () => {
    const token = 'A'.repeat(43);
    expect(ResetPasswordBody.safeParse({ token, newPassword: 'x'.repeat(20) }).success).toBe(true);
    expect(ResetPasswordBody.safeParse({ token: 'court', newPassword: 'x'.repeat(20) }).success).toBe(false);
    expect(ResetPasswordBody.safeParse({ token: `${'A'.repeat(42)}+`, newPassword: 'x'.repeat(20) }).success).toBe(false);
  });
  it('PasswordBody et EmailChangeStartBody', () => {
    expect(PasswordBody.safeParse({ password: 'x' }).success).toBe(true);
    expect(PasswordBody.safeParse({ password: 'x', extra: 1 }).success).toBe(false);
    expect(EmailChangeStartBody.parse({ password: 'x', newEmail: 'Nouveau@Example.com' }).newEmail).toBe('nouveau@example.com');
    expect(EmailChangeStartBody.safeParse({ password: 'x', newEmail: 'élise@example.com' }).success).toBe(false);
  });
});
