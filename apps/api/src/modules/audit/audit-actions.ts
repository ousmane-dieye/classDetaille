import { z } from 'zod';

/**
 * Liste fermée des actions écrites par l'application (source APP) et schéma de leurs métadonnées (§ 2.5).
 * Autorisé : identifiants, énumérations, compteurs. Interdit : contenus, URL, noms, emails, IP, secrets.
 */
export const AUDIT_METADATA = {
  ADMIN_CREATED: z.strictObject({ via: z.literal('cli') }),
  CLASS_CREATED: z.strictObject({ via: z.enum(['cli', 'app']) }),
  CLASS_ARCHIVED: z.strictObject({ classId: z.uuid() }),
  ACCOUNT_REGISTERED: z.strictObject({ classId: z.uuid(), enrollmentRequestId: z.uuid() }),
  PASSWORD_CHANGED: z.strictObject({ revokedSessions: z.number().int().min(0) }),
  SESSIONS_REVOKED: z.strictObject({ reason: z.literal('OTHER_DEVICES'), count: z.number().int().min(0) }),
  ADMIN_LOGIN: z.strictObject({ method: z.enum(['EMAIL_CODE', 'RECOVERY_CODE']) }),
  ADMIN_EMAIL_CHANGED: z.strictObject({ revokedSessions: z.number().int().min(0) }),
  PASSWORD_RESET_COMPLETED: z.strictObject({ revokedSessions: z.number().int().min(0) }),
  ADMIN_SECOND_FACTOR_BLOCKED: z.strictObject({ failures: z.number().int().min(0) }),
  ENROLLMENT_ACCEPTED: z.strictObject({ classId: z.uuid(), userId: z.uuid() }),
  // Le motif de refus n'est jamais journalisé (illégitime § 2.5, cf. R6) ; il part uniquement par email.
  ENROLLMENT_REFUSED: z.strictObject({ classId: z.uuid(), userId: z.uuid() }),
  // Idem pour le motif de retrait : il vit dans class_memberships.left_note, pas dans l'audit.
  MEMBER_REMOVED: z.strictObject({ classId: z.uuid(), userId: z.uuid() }),
  DELEGATE_APPOINTED: z.strictObject({ classId: z.uuid(), userId: z.uuid() }),
  DELEGATE_REVOKED: z.strictObject({ classId: z.uuid(), userId: z.uuid() }),
  // Le nom de la matière est la seule trace après suppression (§ 2.5 : aucun secret dans l'audit).
  SUBJECT_CREATED: z.strictObject({ classId: z.uuid(), subjectId: z.uuid(), name: z.string() }),
  SUBJECT_DELETED: z.strictObject({ classId: z.uuid(), subjectId: z.uuid(), name: z.string() }),
  // Transfert (R7) : d'où, où, qui — jamais d'email ni de liste d'adresses (§ 2.5).
  MEMBER_TRANSFERRED: z.strictObject({ userId: z.uuid(), fromClassId: z.uuid(), toClassId: z.uuid() }),
} as const;
export type AppAuditAction = keyof typeof AUDIT_METADATA;
export type AuditTargetType = 'USER' | 'CLASS' | 'SESSION' | 'ENROLLMENT_REQUEST' | 'SUBJECT';
export const AUDIT_METADATA_MAX_BYTES = 4096;
