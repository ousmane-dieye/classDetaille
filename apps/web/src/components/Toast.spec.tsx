import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { ToastProvider, useToasts } from './Toast';

/** L'écran de test : trois boutons appellent `notify` comme le ferait une action réussie. */
function Harness(): ReactElement {
  const { notify } = useToasts();
  return (
    <div>
      <button onClick={() => notify('success', 'Cours ajouté à votre bibliothèque.')}>Enregistrer le cours</button>
      <button onClick={() => notify('error', 'Une erreur est survenue. Réessaie.')}>Provoquer une erreur</button>
      <button onClick={() => notify('info', 'Un nouveau code vient de partir.')}>Info</button>
    </div>
  );
}

function mount(): void {
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
}

const clickOn = (label: string): void => {
  fireEvent.click(screen.getByRole('button', { name: label }));
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('retours temporaires (§ 3.1)', () => {
  it('un succès s’annonce dans une région « status », avec un bouton pour fermer', () => {
    mount();
    clickOn('Enregistrer le cours');

    const region = screen.getByRole('status');
    expect(region.textContent).toContain('Cours ajouté à votre bibliothèque.');
    // Jamais la couleur seule : l'icône et le texte portent le message.
    expect(screen.getByText('Cours ajouté à votre bibliothèque.').closest('.cp-toast')?.className).toContain('cp-toast--success');

    fireEvent.click(screen.getByRole('button', { name: 'Fermer la notification' }));
    expect(screen.queryByText('Cours ajouté à votre bibliothèque.')).toBeNull();
    // La région disparaît avec son dernier message : jamais une région vide à annoncer.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('une erreur s’annonce dans une région « alert » et reste plus longtemps', () => {
    mount();
    clickOn('Provoquer une erreur');

    expect(screen.getByRole('alert').textContent).toContain('Une erreur est survenue. Réessaie.');

    act(() => vi.advanceTimersByTime(5000));
    // 5 s plus tard, l'erreur est toujours là : le temps de la lire.
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('le message disparaît de lui-même après quelques secondes', () => {
    mount();
    clickOn('Enregistrer le cours');

    act(() => vi.advanceTimersByTime(4999));
    expect(screen.getByText('Cours ajouté à votre bibliothèque.')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2));
    expect(screen.queryByText('Cours ajouté à votre bibliothèque.')).toBeNull();
  });

  it('le survol retient la fermeture : le départ reprend à la sortie', () => {
    mount();
    clickOn('Info');

    // React déduit l'entrée/sortie de la souris de `mouseover`/`mouseout`.
    fireEvent.mouseOver(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(20000));
    expect(screen.getByText('Un nouveau code vient de partir.')).toBeTruthy();

    fireEvent.mouseOut(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText('Un nouveau code vient de partir.')).toBeNull();
  });

  it('un message répété ne s’empile pas : il remplace et repart de zéro', () => {
    mount();
    clickOn('Enregistrer le cours');
    act(() => vi.advanceTimersByTime(4000));
    // Un second clic, encore dans la fenêtre des 5 s : un seul message, timer repris à zéro.
    clickOn('Enregistrer le cours');

    expect(screen.getAllByText('Cours ajouté à votre bibliothèque.')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.getAllByText('Cours ajouté à votre bibliothèque.')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1001));
    expect(screen.queryByText('Cours ajouté à votre bibliothèque.')).toBeNull();
  });

  it('plusieurs messages distincts cohabitent, sans jamais dépasser trois', () => {
    mount();
    clickOn('Enregistrer le cours');
    clickOn('Provoquer une erreur');
    clickOn('Info');

    expect(screen.getAllByText(/^Cours ajouté|^Une erreur|^Un nouveau/)).toHaveLength(3);
  });

  it('sans provider, l’usage est refusé plutôt que silencieux', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow('useToasts doit être utilisé sous un ToastProvider');
    spy.mockRestore();
  });

  it('un retour visible reste conforme (axe-core), clair comme sombre', async () => {
    // axe-core a besoin de ses propres minuteurs : on rend les horloges réelles pour le temps du test.
    vi.useRealTimers();
    document.documentElement.lang = 'fr';
    mount();
    clickOn('Enregistrer le cours');
    clickOn('Provoquer une erreur');

    const container = document.body;
    for (const theme of ['light', 'dark']) {
      document.documentElement.setAttribute('data-theme', theme);
      // jsdom ne rend pas les couleurs : le contraste est couvert par `tokens.spec`.
      const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
      const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious.map((v) => `${v.id} : ${v.nodes.map((n) => n.html).join(' ;; ')}`)).toEqual([]);
    }
    document.documentElement.removeAttribute('data-theme');
  });
});
