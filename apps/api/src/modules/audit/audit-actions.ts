import { z } from 'zod';

/**
 * Liste fermée des actions écrites par l'application (source APP) et schéma de leurs métadonnées (§ 2.5).
 * Autorisé : identifiants, énumérations, compteurs. Interdit : contenus, URL, noms, emails, IP, secrets.
 */
export const AUDIT_METADATA = {
  ADMIN_CREATED: z.strictObject({ via: z.literal('cli') }),
  CLASS_CREATED: z.strictObject({ via: z.literal('cli') }),
  ACCOUNT_REGISTERED: z.strictObject({ classId: z.uuid(), enrollmentRequestId: z.uuid() }),
  PASSWORD_CHANGED: z.strictObject({ revokedSessions: z.number().int().min(0) }),
  SESSIONS_REVOKED: z.strictObject({ reason: z.literal('OTHER_DEVICES'), count: z.number().int().min(0) }),
} as const;
export type AppAuditAction = keyof typeof AUDIT_METADATA;
export type AuditTargetType = 'USER' | 'CLASS' | 'SESSION' | 'ENROLLMENT_REQUEST';
export const AUDIT_METADATA_MAX_BYTES = 4096;
