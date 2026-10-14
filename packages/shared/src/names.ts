/** Prénom ou nom : NFC, espaces réduits. La longueur (2 à 80 points de code) est vérifiée par les schémas et par la base. */
export function normalizeName(input: string): string {
  return input.normalize('NFC').trim().replace(/\s+/g, ' ');
}
