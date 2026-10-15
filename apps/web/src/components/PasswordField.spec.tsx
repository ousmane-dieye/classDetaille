import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasswordField } from './PasswordField';

afterEach(cleanup);

function mount(props: Partial<ComponentProps<typeof PasswordField>> = {}): void {
  render(<PasswordField id="password" label="Mot de passe" value="" onChange={vi.fn()} autoComplete="new-password" {...props} />);
}

describe('PasswordField', () => {
  it('masque la saisie par défaut et la révèle au choix, sans jauge de force', () => {
    mount();
    const input = screen.getByLabelText('Mot de passe') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('new-password');

    const toggle = screen.getByRole('button', { name: 'Afficher' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect((screen.getByLabelText('Mot de passe') as HTMLInputElement).type).toBe('text');
    expect(screen.getByRole('button', { name: 'Masquer' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('indique la longueur saisie et ce qu’il reste, sans barre de progression', () => {
    mount({ minimum: 15, value: '1234567890' });
    const hint = screen.getByText('10');
    expect(hint.parentElement?.textContent).toContain('caractères');
    expect(screen.getByText(/encore 5 pour atteindre 15/)).toBeTruthy();
  });

  it('indique le minimum atteint sans alerte', () => {
    mount({ minimum: 15, value: 'une phrase de passe assez longue' });
    const hint = screen.getByText('32');
    expect(hint.parentElement?.textContent).toContain('15 minimum');
  });

  it('atteint le minimum sans message d’alerte', () => {
    mount({ minimum: 15, value: 'une phrase de passe assez longue' });
    expect(screen.queryByText(/encore/)).toBeNull();
  });

  it('annonce l’erreur sous le champ', () => {
    mount({ error: 'Ce mot de passe est trop court : 15 caractères minimum.' });
    expect(screen.getByRole('alert').textContent).toContain('15 caractères minimum');
    expect(screen.getByLabelText('Mot de passe').getAttribute('aria-invalid')).toBe('true');
  });
});
