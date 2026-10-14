/** Prénom ou nom : NFC, espaces réduits. La longueur (2 à 80 points de code) est vérifiée par les schémas et par la base. */
export function normalizeName(input: string): string {
  return input.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Vrai si le texte (déjà normalisé) contient un caractère de contrôle ou de format (Cc, Cf), NUL compris. */
export function hasForbiddenNameChars(s: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(s);
}

/** Prénom ou nom valide (texte déjà normalisé) : 2 à 80 points de code, sans caractère Cc/Cf. */
export function isValidName(s: string): boolean {
  const n = [...s].length;
  return n >= 2 && n <= 80 && !hasForbiddenNameChars(s);
}
