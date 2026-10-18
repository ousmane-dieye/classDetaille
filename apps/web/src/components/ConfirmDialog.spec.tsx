import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

type Props = Parameters<typeof ConfirmDialog>[0];

afterEach(cleanup);

/** Le formulaire est soumis par son événement : jsdom n'envoie rien de lui-même depuis un bouton. */
function submit(): void {
  const form = document.querySelector('form');
  if (!form) throw new Error('formulaire absent');
  fireEvent.submit(form);
}

function mount(props: Partial<Props> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  render(
    <ConfirmDialog
      title="Retirer Awa Diop de la classe ?"
      confirmLabel="Retirer"
      {...props}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

beforeEach(() => {
  document.documentElement.lang = 'fr';
});

describe('ConfirmDialog (confirmations nommant l’objet, UX § 3.3)', () => {
  it('nomme l’objet dans le titre et dans le corps', () => {
    mount({ body: <>Awa Diop ne verra plus sa classe. Le motif reste facultatif.</> });
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Retirer Awa Diop de la classe ?' })).toBeTruthy();
    expect(screen.getByText(/Awa Diop ne verra plus sa classe\./)).toBeTruthy();
  });

  it('rappelle que la décision est définitive quand on le demande', () => {
    mount({ definitive: true });
    expect(screen.getByText('Cette décision est définitive.')).toBeTruthy();

    cleanup();
    mount({ definitive: false });
    expect(screen.queryByText('Cette décision est définitive.')).toBeNull();
  });

  it('sans champ de motif, la confirmation ne porte aucun champ', () => {
    const { onConfirm } = mount();
    submit();
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('un motif saisi est transmis, espaces compris seulement s’il reste quelque chose', () => {
    const { onConfirm } = mount({ noteLabel: 'Motif' });
    fireEvent.change(screen.getByLabelText('Motif'), { target: { value: '  Ne vient plus en cours  ' } });
    submit();
    expect(onConfirm).toHaveBeenCalledWith('Ne vient plus en cours');

    cleanup();
    const second = mount({ noteLabel: 'Motif' });
    fireEvent.change(screen.getByLabelText('Motif'), { target: { value: '   ' } });
    submit();
    expect(second.onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('une raison d’empêchement s’affiche et bloque la confirmation', () => {
    const { onConfirm } = mount({ blockedReason: 'Cette classe est archivée.', noteLabel: 'Motif' });
    expect(screen.getByText('Cette classe est archivée.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Retirer' }) as HTMLButtonElement).disabled).toBe(true);

    submit();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('affiche le message du serveur sans effacer le motif saisi', () => {
    mount({ problem: 'Cette personne est déjà membre de cette classe.', noteLabel: 'Motif' });
    fireEvent.change(screen.getByLabelText('Motif'), { target: { value: 'Motif gardé' } });
    expect(screen.getByText('Cette personne est déjà membre de cette classe.')).toBeTruthy();
    expect((screen.getByLabelText('Motif') as HTMLInputElement).value).toBe('Motif gardé');
  });

  it('« Annuler » et Échap abandonnent sans confirmer', () => {
    const { onConfirm, onCancel } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('le focus part au premier champ et reste dans le panneau', () => {
    const { onCancel } = mount({ noteLabel: 'Motif' });
    expect(document.activeElement).toBe(screen.getByLabelText('Motif'));

    fireEvent.keyDown(screen.getByLabelText('Motif'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Annuler' }));

    fireEvent.keyDown(screen.getByRole('button', { name: 'Annuler' }), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Motif'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('sans champ de motif, le focus part à la confirmation et y revient en fermant', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Accepter';
    document.body.append(trigger);
    trigger.focus();

    const onConfirm = vi.fn();
    const { unmount } = render(
      <ConfirmDialog title="Retirer Awa Diop de la classe ?" confirmLabel="Retirer" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    const confirm = screen.getByRole('button', { name: 'Retirer' });
    const cancel = screen.getByRole('button', { name: 'Annuler' });
    expect(document.activeElement).toBe(confirm);

    // Le premier et le dernier s'enroulent : au milieu, la tabulation est celle du navigateur.
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(confirm);

    unmount();
    expect(document.activeElement).toBe(trigger);
    expect(onConfirm).not.toHaveBeenCalled();
    trigger.remove();
  });

  it.each(['light', 'dark'] as const)('aucune violation sérieuse en thème %s', async (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    const { container } = render(
      <ConfirmDialog
        title="Refuser la demande de Awa Diop ?"
        confirmLabel="Refuser la demande"
        noteLabel="Motif"
        definitive
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id} (${v.impact}) : ${v.nodes.map((n) => n.html).join(' ;; ')}`)).toEqual([]);
    document.documentElement.removeAttribute('data-theme');
  });
});
