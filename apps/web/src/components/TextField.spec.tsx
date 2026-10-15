import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextField } from './TextField';

afterEach(cleanup);

function mount(props: Partial<ComponentProps<typeof TextField>> = {}): void {
  render(<TextField id="email" label="Email" value="" onChange={vi.fn()} {...props} />);
}

describe('TextField', () => {
  it('a un libellé visible lié au champ', () => {
    mount({ type: 'email' });
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    expect(input.id).toBe('email');
    expect(input.type).toBe('email');
  });

  it('transmet la valeur et prévient du changement', () => {
    const onChange = vi.fn();
    mount({ onChange, value: 'awa@example.com' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.sn' } });
    expect(onChange).toHaveBeenCalledWith('a@b.sn');
  });

  it('annonce l’erreur et la lie au champ', () => {
    mount({ error: 'Cette adresse email n’est pas valide.', hint: 'Tes rappels arriveront ici.' });
    const input = screen.getByLabelText('Email');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Cette adresse email n’est pas valide.');
    const describedBy = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy).toContain('email-error');
    expect(describedBy).toContain('email-hint');
  });

  it('sans erreur, le champ n’est pas marqué invalide', () => {
    mount({ hint: 'Aide' });
    const input = screen.getByLabelText('Email');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('respecte le clavier demandé', () => {
    mount({ inputMode: 'numeric' });
    expect(screen.getByLabelText('Email').getAttribute('inputmode')).toBe('numeric');
  });
});
