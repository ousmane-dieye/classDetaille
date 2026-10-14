/** Forme normalisée d'un email (§ 2.1) : espaces au début et à la fin supprimés, puis NFKC, puis minuscules. */
export function normalizeEmail(input: string): string {
  return input.trim().normalize('NFKC').toLowerCase();
}

const LOCAL = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const EMAIL_RE = new RegExp(`^${LOCAL}@${LABEL}(?:\\.${LABEL})+$`);

/** Email accepté au MVP : ASCII, au plus 254 caractères, domaine avec au moins un point. */
export function isAcceptedEmail(normalized: string): boolean {
  return normalized.length <= 254 && EMAIL_RE.test(normalized);
}
