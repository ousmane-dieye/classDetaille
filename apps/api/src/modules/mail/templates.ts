import { KIND_SCHEMAS, isSupportedKind, type EmailKind } from './email-kinds.js';

export class RenderError extends Error {}
export type RenderContext = { appOrigin: string };
export const RESET_PASSWORD_PATH = '/reinitialiser-mot-de-passe';

const SIGNATURE = '\n\nL’équipe ClassePulse';
const lines = (...l: string[]): string => `${l.join('\n')}${SIGNATURE}`;

/** Modèles en texte brut, français, tutoiement. Un champ inconnu ou un secret invalide fait échouer le rendu. */
export function renderEmail(kind: EmailKind, payload: unknown, secret: unknown, ctx: RenderContext): { subject: string; text: string } {
  if (!isSupportedKind(kind)) throw new RenderError(`no template for ${kind}`);
  const schemas = KIND_SCHEMAS[kind];
  const p = schemas.payload.safeParse(payload);
  if (!p.success) throw new RenderError(`invalid payload for ${kind}`);
  let s: Record<string, string> = {};
  if (schemas.secret) {
    const parsed = schemas.secret.safeParse(secret);
    if (!parsed.success) throw new RenderError(`invalid secret for ${kind}`);
    s = parsed.data as Record<string, string>;
  }
  const d = p.data as Record<string, unknown>;
  switch (kind) {
    case 'ADMIN_OTP':
      return {
        subject: d.purpose === 'STEP_UP' ? 'Ton code de vérification ClassePulse' : 'Ton code de connexion ClassePulse',
        text: lines('Bonjour,', '', `Voici ton code : ${s.code}`, '',
          'Il est valable 10 minutes et ne sert qu’une fois. Si tu n’es pas à l’origine de cette demande, change ton mot de passe sans attendre et préviens un autre administrateur.'),
      };
    case 'ADMIN_EMAIL_CHANGE_OLD':
      return {
        subject: 'Confirme le changement de ton adresse email',
        text: lines('Bonjour,', '', `Tu as demandé à remplacer l’adresse de ton compte par ${String(d.newEmail)}.`, `Voici ton code de confirmation : ${s.code}`, '',
          'Il est valable 10 minutes. Si ce n’est pas toi, ne l’utilise pas et change ton mot de passe sans attendre.'),
      };
    case 'ADMIN_EMAIL_CHANGE_NEW':
      return {
        subject: 'Confirme ta nouvelle adresse email',
        text: lines('Bonjour,', '', 'Cette adresse va devenir celle de ton compte administrateur ClassePulse.', `Voici ton code de confirmation : ${s.code}`, '',
          'Il est valable 10 minutes. Si tu ne reconnais pas cette demande, ignore ce message.'),
      };
    case 'PASSWORD_RESET':
      return {
        subject: 'Réinitialise ton mot de passe ClassePulse',
        text: lines('Bonjour,', '', 'Pour choisir un nouveau mot de passe, ouvre ce lien :', `${ctx.appOrigin}${RESET_PASSWORD_PATH}#token=${s.token}`, '',
          'Il est valable 30 minutes et ne sert qu’une fois. Si tu n’as rien demandé, ignore ce message : ton mot de passe reste inchangé.'),
      };
    case 'SECURITY_ALERT':
      return d.event === 'PASSWORD_RESET'
        ? { subject: 'Ton mot de passe ClassePulse a été réinitialisé', text: lines('Bonjour,', '', 'Le mot de passe de ton compte vient d’être réinitialisé et tes appareils ont été déconnectés.', 'Si ce n’est pas toi, contacte un administrateur sans attendre.') }
        : { subject: 'L’adresse de ton compte ClassePulse a changé', text: lines('Bonjour,', '', 'L’adresse email de ton compte vient d’être remplacée. Cette adresse ne recevra plus de messages.', 'Si ce n’est pas toi, contacte un autre administrateur sans attendre.') };
    case 'ADMIN_SECURITY_ALERT': {
      const who = String(d.accountEmail);
      const what: Record<string, string> = {
        SECOND_FACTOR_FAILURES: `Plusieurs codes erronés ont été saisis pour le compte administrateur ${who} (${String(d.failures ?? '?')} échecs en 60 minutes).`,
        SECOND_FACTOR_BLOCKED: `Le compte administrateur ${who} est bloqué après 10 codes erronés. Seul un opérateur peut le débloquer.`,
        EMAIL_CHANGED: `L’adresse du compte administrateur ${who} vient d’être remplacée.`,
        RECOVERY_CODE_ISSUED: `Un code de récupération vient d’être émis par un opérateur pour le compte administrateur ${who}.`,
      };
      return { subject: 'Alerte de sécurité ClassePulse', text: lines('Bonjour,', '', what[String(d.event)]!, '', 'Si tu ne reconnais pas cet événement, préviens les autres administrateurs.') };
    }
    case 'TEST':
      return { subject: 'Test ClassePulse', text: lines('Ceci est un message de test.') };
  }
}
