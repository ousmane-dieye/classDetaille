import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THEME_KEY, applyStoredTheme, applyTheme, readTheme } from './theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('thème (P10)', () => {
  it('retombe sur le thème du système quand rien n’est choisi', () => {
    expect(readTheme()).toBe('system');
    applyStoredTheme();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('mémorisé dans cp.theme, il est relu au démarrage', () => {
    applyTheme('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    document.documentElement.removeAttribute('data-theme');
    applyStoredTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('le clair retire l’attribut de force sombre', () => {
    applyTheme('dark');
    applyTheme('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignore une valeur inconnue dans le stockage', () => {
    localStorage.setItem(THEME_KEY, 'arc-en-ciel');
    expect(readTheme()).toBe('system');
  });
});
