import { z } from 'zod';

// Décision d'adhésion (P8) et re-demande d'un compte existant (R16) : le délai de 24 h et
// l'absence d'appartenance sont portés par la base (déclencheur enrollment_request_valid).
// Le motif (refus, retrait) est facultatif, borné à 500 caractères — la même borne que la colonne en base.
const Note = z.string().trim().min(1).max(500).optional();

export const RefuseEnrollmentBody = z.strictObject({ note: Note });
export type RefuseEnrollmentBody = z.infer<typeof RefuseEnrollmentBody>;

export const RemoveMemberBody = z.strictObject({ note: Note });
export type RemoveMemberBody = z.infer<typeof RemoveMemberBody>;

export const CreateEnrollmentBody = z.strictObject({
  classId: z.uuid(),
});
export type CreateEnrollmentBody = z.infer<typeof CreateEnrollmentBody>;
