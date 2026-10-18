import { z } from 'zod';

// Décision d'adhésion (P8) et re-demande d'un compte existant (R16) : le délai de 24 h et
// l'absence d'appartenance sont portés par la base (déclencheur enrollment_request_valid).
// Le motif (refus, retrait) est facultatif, borné à 500 caractères — la même borne que la colonne en base.
const Note = z.string().trim().min(1).max(500).optional();

export const RefuseEnrollmentBody = z.strictObject({ note: Note });
export type RefuseEnrollmentBody = z.infer<typeof RefuseEnrollmentBody>;

export const RemoveMemberBody = z.strictObject({ note: Note });
export type RemoveMemberBody = z.infer<typeof RemoveMemberBody>;

export const AppointDelegateBody = z.strictObject({
  userId: z.uuid(),
});
export type AppointDelegateBody = z.infer<typeof AppointDelegateBody>;

export const CreateEnrollmentBody = z.strictObject({
  classId: z.uuid(),
});
export type CreateEnrollmentBody = z.infer<typeof CreateEnrollmentBody>;

// Transfert (R7) : le simple vise une destination saisie, la masse vise la classe du corps de la
// requête (`:classId` = destination, M13 : créer la classe nouvelle, y transférer, archiver l'ancienne).
// Le seuil de 200 étudiants par appel est porté par le service (`400 BATCH_TOO_LARGE`) ;
// l'unicité et l'appartenance active sont portées par la base.
export const TransferBody = z.strictObject({
  toClassId: z.uuid(),
});
export type TransferBody = z.infer<typeof TransferBody>;

export const TransferBatchBody = z.strictObject({
  userIds: z.array(z.uuid()).min(1).max(1000),
});
export type TransferBatchBody = z.infer<typeof TransferBatchBody>;
