import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

afterEach(cleanup);

describe('Button', () => {
  it('affiche son libellé et réagit au clic', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Envoyer ma demande</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer ma demande' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('n’est jamais désactivé sans raison', () => {
    render(<Button>Se connecter</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('signale l’envoi en cours et ne se relance pas', () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Envoyer
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement;
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('respecte la variante demandée', () => {
    render(<Button variant="secondary">Annuler</Button>);
    expect(screen.getByRole('button').className).toContain('cp-btn--secondary');
  });
});
