export const PASSWORD_MIN = { USER: 15, ADMIN: 16 } as const;
export const PASSWORD_MAX = 128;

/** Normalisation identique dans tous les parcours (§ 3.2). */
export function normalizePassword(p: string): string {
  return p.normalize('NFKC');
}

/** Longueur en points de code, après NFKC. */
export function passwordLength(p: string): number {
  return [...normalizePassword(p)].length;
}

export function checkPasswordLength(p: string, role: 'USER' | 'ADMIN'): 'TOO_SHORT' | 'TOO_LONG' | null {
  const n = passwordLength(p);
  if (n > PASSWORD_MAX) return 'TOO_LONG';
  if (n < PASSWORD_MIN[role]) return 'TOO_SHORT';
  return null;
}
