import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

afterEach(cleanup);

describe('application', () => {
  it('propose un lien « Aller au contenu » pointant vers le repère principal', () => {
    render(<App />);
    const link = screen.getByRole('link', { name: 'Aller au contenu' });
    expect(link.getAttribute('href')).toBe('#contenu');
  });

  it('déclare la langue française dans la page', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('<meta name="viewport"');
  });
});
