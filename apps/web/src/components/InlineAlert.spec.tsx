import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InlineAlert } from './InlineAlert';

afterEach(cleanup);

describe('InlineAlert', () => {
  it('annonce un message d’erreur, avec un texte et jamais la couleur seule', () => {
    render(<InlineAlert tone="error">Email ou mot de passe incorrect.</InlineAlert>);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Email ou mot de passe incorrect.');
    // L’icône est décorative : ignorée par les lecteurs d’écran.
    expect(alert.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('reste muette quand aucun message n’est fourni', () => {
    const { container } = render(<InlineAlert tone="error" />);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
