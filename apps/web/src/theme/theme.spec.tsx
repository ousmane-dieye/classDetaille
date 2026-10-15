import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, loadPreference, savePreference } from './theme';

afterEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme; vi.restoreAllMocks(); });

describe('thème', () => {
  it('par défaut : système', () => expect(loadPreference()).toBe('system'));
  it('mémorise un choix manuel', () => { savePreference('dark'); expect(loadPreference()).toBe('dark'); });
  it('ignore une valeur inconnue', () => { localStorage.setItem('cp.theme', 'pink'); expect(loadPreference()).toBe('system'); });
  it('reste utilisable si le stockage est indisponible', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => savePreference('light')).not.toThrow();
    expect(loadPreference()).toBe('system');
  });
  it('applique le thème choisi ou celui du système', () => {
    applyTheme('light', true); expect(document.documentElement.dataset.theme).toBe('light');
    applyTheme('system', true); expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('system', false); expect(document.documentElement.dataset.theme).toBe('light');
  });
});
