export type ThemePreference = 'system' | 'light' | 'dark';
const KEY = 'cp.theme';
const VALID: readonly ThemePreference[] = ['system', 'light', 'dark'];

export function loadPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return VALID.includes(v as ThemePreference) ? (v as ThemePreference) : 'system';
  } catch {
    return 'system';
  }
}

export function savePreference(p: ThemePreference): void {
  try { localStorage.setItem(KEY, p); } catch { /* préférence non mémorisée : comportement par défaut conservé */ }
}

export function applyTheme(pref: ThemePreference, prefersDark: boolean): void {
  const mode = pref === 'system' ? (prefersDark ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = mode;
}
