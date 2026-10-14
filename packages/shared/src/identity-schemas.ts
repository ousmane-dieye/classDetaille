import { z } from 'zod';
import { isAcceptedEmail, normalizeEmail } from './email.js';
import { isValidName, normalizeName } from './names.js';

// Le mot de passe brut est borné à 1024 caractères avant toute normalisation (défense contre les corps énormes) ;
// la règle métier (15/16 à 128 après NFKC) est appliquée par le serveur, avec un code d'erreur précis.
export const RawPasswordField = z.string().min(1).max(1024, { message: 'PASSWORD_TOO_LONG' });
export const EmailField = z.string().max(320).transform(normalizeEmail).refine(isAcceptedEmail, { message: 'INVALID_EMAIL' });
// Longueur en points de code (et non en unités UTF-16) : un emoji seul compte pour 1.
const Name = z
  .string()
  .max(400)
  .transform(normalizeName)
  .pipe(
    z
      .string()
      .refine((s) => [...s].length >= 2 && [...s].length <= 80, { message: 'INVALID_NAME_LENGTH' })
      .refine(isValidName, { message: 'INVALID_NAME' }),
  );

export const RegisterBody = z.strictObject({
  firstName: Name,
  lastName: Name,
  email: EmailField,
  password: RawPasswordField,
  classId: z.uuid(),
  turnstileToken: z.string().min(1).max(2048),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const LoginBody = z.strictObject({
  email: EmailField,
  password: RawPasswordField,
  turnstileToken: z.string().min(1).max(2048).optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const UpdateProfileBody = z.strictObject({ firstName: Name, lastName: Name });
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

export const UpdatePreferencesBody = z
  .strictObject({ emailReminders: z.boolean().optional(), emailAnnouncements: z.boolean().optional() })
  .refine((v) => v.emailReminders !== undefined || v.emailAnnouncements !== undefined, { message: 'EMPTY' });
export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBody>;

export const ChangePasswordBody = z.strictObject({ currentPassword: RawPasswordField, newPassword: RawPasswordField });
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;
