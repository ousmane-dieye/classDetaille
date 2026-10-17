import { z } from 'zod';

/**
 * Corps de création d'une matière (R12) : bornes structurelles ici ; la sémantique
 * (2 à 60 points de code, NFC, sans caractère Cc/Cf — `isValidSubjectName`) est vérifiée
 * en service pour produire `400 INVALID_SUBJECT_NAME` plutôt qu'une erreur générique de pipe.
 */
export const CreateSubjectBody = z.strictObject({
  name: z.string().min(1).max(200),
});
export type CreateSubjectBody = z.infer<typeof CreateSubjectBody>;

/**
 * Corps de création d'une classe dans l'application (R8, admin) : bornes structurelles ici ;
 * la sémantique (nom 2–80, niveau 1–40, année AAAA-AAAA consécutive) est vérifiée en service
 * pour produire `400 INVALID_CLASS_NAME | INVALID_CLASS_LEVEL | INVALID_ACADEMIC_YEAR`.
 */
export const CreateClassBody = z.strictObject({
  name: z.string().min(1).max(200),
  level: z.string().min(1).max(80),
  academicYear: z.string().min(4).max(9),
});
export type CreateClassBody = z.infer<typeof CreateClassBody>;
