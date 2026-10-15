import { describe, expect, it } from 'vitest';
import { formatDateTime, formatLongDate } from './format';

describe('mise en forme des dates', () => {
  it('affiche les dates comme la maquette : « 14 oct. à 09:41 »', () => {
    const date = new Date(2026, 9, 14, 9, 41);
    expect(formatDateTime(date.toISOString())).toBe('14 oct. à 09:41');
  });

  it('affiche la date seule en toutes lettres', () => {
    const date = new Date(2026, 9, 15, 9, 41);
    expect(formatLongDate(date.toISOString())).toBe('15 octobre 2026');
  });

  it('accepte une date invalide sans planter', () => {
    expect(formatDateTime('pas-une-date')).toBe('');
    expect(formatLongDate('pas-une-date')).toBe('');
  });
});
