/** Nom du cookie de session (§ 2.7) : préfixe `__Host-` (Secure, Path=/, sans Domain). Partagé par le socle HTTP et les sessions. */
export const SESSION_COOKIE = '__Host-cp_session';

/** Nom du cookie de vérification de connexion d'un administrateur (§ 3.3). */
export const CHALLENGE_COOKIE = '__Host-cp_challenge';
