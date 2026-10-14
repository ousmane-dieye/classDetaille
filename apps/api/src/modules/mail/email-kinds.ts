import { z } from 'zod';

export const EMAIL_KINDS = [
  'WELCOME', 'REFUSAL', 'PASSWORD_RESET', 'DIGEST', 'ANNOUNCEMENT', 'ADMIN_ALERT', 'SECURITY_ALERT',
  'ADMIN_SECURITY_ALERT', 'ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW', 'TEST',
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** Envoyés même quand bulk_email_paused est vrai (§ 2.4) ; la réservation SQL reçoit cette liste en paramètre. */
export const SECURITY_KINDS: ReadonlySet<EmailKind> = new Set<EmailKind>([
  'PASSWORD_RESET', 'SECURITY_ALERT', 'ADMIN_SECURITY_ALERT', 'ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW',
]);
/** Portent un secret chiffré (miroir du CHECK email_outbox_secret_kinds). */
export const SECRET_KINDS: ReadonlySet<EmailKind> = new Set<EmailKind>(['PASSWORD_RESET', 'ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW']);

const otp = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) });

/** Types disposant d'un modèle au lot 1b. `payload` n'est jamais secret ; `secret` est chiffré (AES-256-GCM). */
export const KIND_SCHEMAS = {
  ADMIN_OTP: { payload: z.strictObject({ purpose: z.enum(['LOGIN', 'STEP_UP']) }), secret: otp },
  ADMIN_EMAIL_CHANGE_OLD: { payload: z.strictObject({ newEmail: z.string().max(254) }), secret: otp },
  ADMIN_EMAIL_CHANGE_NEW: { payload: z.strictObject({}), secret: otp },
  PASSWORD_RESET: { payload: z.strictObject({}), secret: z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }) },
  SECURITY_ALERT: { payload: z.strictObject({ event: z.enum(['PASSWORD_RESET', 'EMAIL_CHANGED']) }), secret: null },
  ADMIN_SECURITY_ALERT: {
    payload: z.strictObject({
      event: z.enum(['SECOND_FACTOR_FAILURES', 'SECOND_FACTOR_BLOCKED', 'EMAIL_CHANGED', 'RECOVERY_CODE_ISSUED']),
      accountEmail: z.string().max(254),
      failures: z.number().int().min(0).optional(),
    }),
    secret: null,
  },
  TEST: { payload: z.strictObject({}), secret: null },
} as const;
export type SupportedKind = keyof typeof KIND_SCHEMAS;
export const isSupportedKind = (k: EmailKind): k is SupportedKind => k in KIND_SCHEMAS;
