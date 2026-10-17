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
