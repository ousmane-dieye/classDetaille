import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Banner } from './Banner';

afterEach(cleanup);

describe('Banner (M14, hors connexion)', () => {
  it('ne montre rien tant que le réseau répond', () => {
    render(<Banner online={true} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('annonce poliment la perte de connexion', () => {
    render(<Banner online={false} />);
    expect(screen.getByRole('status').textContent).toBe('Connexion perdue — reconnexion…');
  });

  it('disparaît au retour du réseau', () => {
    const { rerender } = render(<Banner online={false} />);
    rerender(<Banner online={true} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
