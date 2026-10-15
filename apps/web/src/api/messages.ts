/**
 * Traduction des codes d'erreur de l'API (lots 1a et 1b, « Codes d'erreur du lot 1b » du README)
 * en textes français, au tutoiement, qui nomment la cause sans accuser (UX § 3.3).
 * Un code non prévu donne un texte générique : un code ajouté côté API n'apparaît jamais tel quel.
 */

export const GENERIC_MESSAGE = 'Une erreur est survenue. Réessaie.';

const TEXTS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Email ou mot de passe incorrect.',
  ACCOUNT_SUSPENDED: 'Ton compte est suspendu. Contacte la plateforme.',
  UNAUTHENTICATED: 'Ta session a pris fin. Connecte-toi à nouveau.',
  FORBIDDEN: "Tu n'as pas le droit de faire cette action.",
  VALIDATION_FAILED: 'Certaines informations sont invalides : vérifie le formulaire.',
  PASSWORD_TOO_SHORT: 'Ce mot de passe est trop court : 15 caractères minimum.',
  PASSWORD_TOO_LONG: 'Ce mot de passe est trop long : 128 caractères maximum.',
  PASSWORD_TOO_COMMON: 'Ce mot de passe est trop courant. Choisis-en un autre.',
  INVALID_EMAIL: 'Cette adresse email n’est pas valide.',
  INVALID_NAME: 'Ce nom contient des caractères qui ne sont pas autorisés.',
  EMAIL_TAKEN: 'Un compte existe déjà avec cet email. Essaie de te connecter.',
  EMAIL_UNCHANGED: 'Cette adresse email est déjà la tienne.',
  CLASS_NOT_AVAILABLE: "Cette classe n'est plus disponible. Choisis-en une autre.",
  SIGNUP_UNAVAILABLE: "L'inscription est temporairement indisponible. Réessaie dans un instant.",
  RESET_UNAVAILABLE: 'La réinitialisation est temporairement indisponible. Réessaie dans un instant.',
  TURNSTILE_REQUIRED: 'Vérifie que tu es bien une personne pour continuer.',
  TURNSTILE_FAILED: 'La vérification anti-robot a échoué. Réessaie.',
  TOO_MANY_ATTEMPTS: 'Trop de tentatives. Attends un peu avant de réessayer.',
  TOO_MANY_REQUESTS: 'Trop de requêtes. Attends un peu avant de réessayer.',
  TOO_MANY_CODE_REQUESTS: 'Trop de demandes de code. Attends un peu avant d’en redemander un.',
  CHALLENGE_EXPIRED: 'Ce code n’est plus valable. Connecte-toi à nouveau pour recevoir un code.',
  CODE_INVALID: 'Code incorrect.',
  CODE_LOCKED: 'Trop de codes incorrects : ce code n’est plus utilisable. Connecte-toi à nouveau.',
  SECOND_FACTOR_BLOCKED: 'Ton compte est bloqué après trop d’échecs. Contacte la plateforme.',
  RESET_TOKEN_INVALID: 'Ce lien n’est plus valable. Demande un nouveau mot de passe oublié.',
  CURRENT_PASSWORD_INVALID: 'Ce mot de passe actuel est incorrect.',
  REAUTH_REQUIRED: 'Confirme ton mot de passe pour continuer.',
  STEP_UP_REQUIRED: 'Confirme ton identité pour continuer.',
  CSRF_REJECTED: "Cette action n'est pas autorisée depuis cette page. Recharge-la.",
  NOT_FOUND: "Cet élément n'existe pas ou n'est plus disponible.",
  CONFLICT: "Cette action n'est plus possible : l'état a changé. Recharge la page.",
  INVALID_JSON: 'La requête est invalide. Réessaie.',
  PAYLOAD_TOO_LARGE: 'Le contenu envoyé est trop volumineux.',
  UNSUPPORTED_MEDIA_TYPE: "Cette action n'est pas autorisée depuis cette page. Recharge-la.",
  NETWORK: 'Connexion impossible. Vérifie ta connexion internet.',
  INTERNAL: GENERIC_MESSAGE,
};

function attemptsText(attemptsLeft: number): string {
  return `Code incorrect. Il te reste ${attemptsLeft} ${attemptsLeft > 1 ? 'essais' : 'essai'}.`;
}

function stepUpText(missing: unknown): string {
  if (missing === 'PASSWORD') return 'Confirme ton mot de passe pour continuer.';
  if (missing === 'CODE') return 'Entre le code reçu par email pour continuer.';
  return 'Confirme ton identité pour continuer.';
}

/** Texte affiché pour un code de l'API. `extra` porte les champs sûrs renvoyés par le serveur. */
export function messageFor(code: string, extra: Record<string, unknown> = {}): string {
  if (code === 'CODE_INVALID' && typeof extra.attemptsLeft === 'number') return attemptsText(extra.attemptsLeft);
  if (code === 'STEP_UP_REQUIRED') return stepUpText(extra.missing);
  return TEXTS[code] ?? GENERIC_MESSAGE;
}
