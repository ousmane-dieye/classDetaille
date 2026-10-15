import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StateScreen } from './StateScreen';

afterEach(cleanup);

describe('StateScreen (M14)', () => {
  it('présente un titre, un texte et des actions', () => {
    render(
      <StateScreen title="Demande envoyée" actions={<button type="button">Se déconnecter</button>}>
        <p>Ta demande a bien été envoyée.</p>
      </StateScreen>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Demande envoyée' })).toBeTruthy();
    expect(screen.getByText('Ta demande a bien été envoyée.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeTruthy();
  });

  it('masque l’icône aux lecteurs d’écran', () => {
    const { container } = render(
      <StateScreen title="Titre" icon={<svg />}>
        <p>texte</p>
      </StateScreen>,
    );
    const icon = container.querySelector('.cp-state__icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('s’adapte sans texte ni action', () => {
    render(<StateScreen title="Titre nue" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Titre nue' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
