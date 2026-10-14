import { z } from 'zod';
import { EmailField, RawPasswordField } from './identity-schemas.js';

export const OTP_LENGTH = 6;
export const RECOVERY_CODE_LENGTH = 12;
/** 31 symboles : ni I, L, O (confusion avec 1 et 0), ni 0, ni 1 (R15). */
export const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Espaces et tirets retirés (« 123 456 » collé depuis un email). */
const stripSeparators = (s: string): string => s.replace(/[\s-]/g, '');

export function normalizeRecoveryCode(input: string): string {
  return stripSeparators(input).toUpperCase();
}

export const OtpCode = z
  .string()
  .max(32)
  .transform(stripSeparators)
  .pipe(z.string().regex(new RegExp(`^[0-9]{${OTP_LENGTH}}$`), { message: 'INVALID_CODE' }));

export const RecoveryCode = z
  .string()
  .max(64)
  .transform(normalizeRecoveryCode)
  .pipe(z.string().regex(new RegExp(`^[${RECOVERY_ALPHABET}]{${RECOVERY_CODE_LENGTH}}$`), { message: 'INVALID_CODE' }));

export const VerifyCodeBody = z.strictObject({ code: OtpCode });
export type VerifyCodeBody = z.infer<typeof VerifyCodeBody>;

export const VerifyRecoveryBody = z.strictObject({ recoveryCode: RecoveryCode });
export type VerifyRecoveryBody = z.infer<typeof VerifyRecoveryBody>;

export const ForgotPasswordBody = z.strictObject({ email: EmailField, turnstileToken: z.string().min(1).max(2048) });
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBody>;

export const ResetPasswordBody = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  newPassword: RawPasswordField,
});
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>;

export const PasswordBody = z.strictObject({ password: RawPasswordField });
export type PasswordBody = z.infer<typeof PasswordBody>;

export const EmailChangeStartBody = z.strictObject({ password: RawPasswordField, newEmail: EmailField });
export type EmailChangeStartBody = z.infer<typeof EmailChangeStartBody>;
