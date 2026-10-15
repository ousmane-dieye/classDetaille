export const THEME_KEY = 'cp.theme';

export type ThemeChoice = 'system' | 'light' | 'dark';

const isChoice = (value: string | null): value is ThemeChoice => value === 'system' || value === 'light' || value === 'dark';

/** Choix mémorisé (P10) : `cp.theme` vaut `system`, `light` ou `dark`, rien d'autre. */
export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Applique le choix : `system` laisse la feuille de style suivre la préférence du système. */
export function applyTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Stockage indisponible (navigation privée) : le thème reste valable pour la session.
  }
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
}

/** Au démarrage : reprend le thème choisi, avant même d'ouvrir le profil. */
export function applyStoredTheme(): void {
  const choice = readTheme();
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
}
