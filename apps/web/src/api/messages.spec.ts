import { describe, expect, it } from 'vitest';
import { GENERIC_MESSAGE, messageFor } from './messages';

describe('textes français des erreurs', () => {
  it.each([
    ['INVALID_CREDENTIALS', 'Email ou mot de passe incorrect.'],
    ['ACCOUNT_SUSPENDED', 'Ton compte est suspendu. Contacte la plateforme.'],
    ['UNAUTHENTICATED', 'Ta session a pris fin. Connecte-toi à nouveau.'],
    ['FORBIDDEN', "Tu n'as pas le droit de faire cette action."],
    ['VALIDATION_FAILED', 'Certaines informations sont invalides : vérifie le formulaire.'],
    ['PASSWORD_TOO_SHORT', 'Ce mot de passe est trop court : 15 caractères minimum.'],
    ['PASSWORD_TOO_LONG', 'Ce mot de passe est trop long : 128 caractères maximum.'],
    ['PASSWORD_TOO_COMMON', 'Ce mot de passe est trop courant. Choisis-en un autre.'],
    ['INVALID_EMAIL', 'Cette adresse email n’est pas valide.'],
    ['INVALID_NAME', 'Ce nom contient des caractères qui ne sont pas autorisés.'],
    ['EMAIL_TAKEN', 'Un compte existe déjà avec cet email. Essaie de te connecter.'],
    ['CLASS_NOT_AVAILABLE', "Cette classe n'est plus disponible. Choisis-en une autre."],
    ['SIGNUP_UNAVAILABLE', "L'inscription est temporairement indisponible. Réessaie dans un instant."],
    ['RESET_UNAVAILABLE', 'La réinitialisation est temporairement indisponible. Réessaie dans un instant.'],
    ['TURNSTILE_REQUIRED', 'Vérifie que tu es bien une personne pour continuer.'],
    ['TURNSTILE_FAILED', 'La vérification anti-robot a échoué. Réessaie.'],
    ['TOO_MANY_ATTEMPTS', 'Trop de tentatives. Attends un peu avant de réessayer.'],
    ['TOO_MANY_REQUESTS', 'Trop de requêtes. Attends un peu avant de réessayer.'],
    ['TOO_MANY_CODE_REQUESTS', 'Trop de demandes de code. Attends un peu avant d’en redemander un.'],
    ['CHALLENGE_EXPIRED', 'Ce code n’est plus valable. Connecte-toi à nouveau pour recevoir un code.'],
    ['CODE_LOCKED', 'Trop de codes incorrects : ce code n’est plus utilisable. Connecte-toi à nouveau.'],
    ['SECOND_FACTOR_BLOCKED', 'Ton compte est bloqué après trop d’échecs. Contacte la plateforme.'],
    ['RESET_TOKEN_INVALID', 'Ce lien n’est plus valable. Demande un nouveau mot de passe oublié.'],
    ['CURRENT_PASSWORD_INVALID', 'Ce mot de passe actuel est incorrect.'],
    ['EMAIL_UNCHANGED', 'Cette adresse email est déjà la tienne.'],
    ['CLASS_NOT_AVAILABLE', "Cette classe n'est plus disponible. Choisis-en une autre."],
    ['CSRF_REJECTED', "Cette action n'est pas autorisée depuis cette page. Recharge-la."],
    ['NOT_FOUND', "Cet élément n'existe pas ou n'est plus disponible."],
    ['CONFLICT', "Cette action n'est plus possible : l'état a changé. Recharge la page."],
    ['INVALID_JSON', 'La requête est invalide. Réessaie.'],
    ['PAYLOAD_TOO_LARGE', 'Le contenu envoyé est trop volumineux.'],
    ['NETWORK', 'Connexion impossible. Vérifie ta connexion internet.'],
  ])('%s a un texte français', (code, text) => {
    expect(messageFor(code)).toBe(text);
  });

  it('un code inconnu donne le texte générique, jamais un code brut', () => {
    expect(messageFor('SOME_FUTURE_CODE')).toBe(GENERIC_MESSAGE);
    expect(messageFor('')).toBe(GENERIC_MESSAGE);
  });

  it('indique le nombre d’essais restants pour un code incorrect', () => {
    expect(messageFor('CODE_INVALID', { attemptsLeft: 4 })).toBe('Code incorrect. Il te reste 4 essais.');
    expect(messageFor('CODE_INVALID', { attemptsLeft: 1 })).toBe('Code incorrect. Il te reste 1 essai.');
    expect(messageFor('CODE_INVALID')).toBe('Code incorrect.');
  });

  it('précise ce qui manque pour une vérification supplémentaire', () => {
    expect(messageFor('STEP_UP_REQUIRED', { missing: 'PASSWORD' })).toBe('Confirme ton mot de passe pour continuer.');
    expect(messageFor('STEP_UP_REQUIRED', { missing: 'CODE' })).toBe('Entre le code reçu par email pour continuer.');
    expect(messageFor('STEP_UP_REQUIRED')).toBe('Confirme ton identité pour continuer.');
  });

  it('les codes interdits au web restent couverts par le texte générique', () => {
    // Un code ajouté côté API sans texte préparé ne doit jamais apparaître tel quel à l'écran.
    expect(messageFor('ADMIN_SECOND_FACTOR_REQUIRED')).toBe(GENERIC_MESSAGE);
  });
});
