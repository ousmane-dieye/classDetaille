import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OtpInput } from './OtpInput';

afterEach(cleanup);

/** Monte le champ avec son propre état, comme le fera l'écran. */
function mount(initial = ''): { value: string } {
  const state: { value: string } = { value: initial };
  const Harness = (): ReactElement => {
    const [value, setValue] = useState(initial);
    state.value = value;
    return <OtpInput value={value} onChange={setValue} />;
  };
  render(<Harness />);
  return state;
}

const cells = (): HTMLInputElement[] => screen.getAllByLabelText(/^Chiffre /) as HTMLInputElement[];

/** Accès garanti à une case (index contrôlé, `noUncheckedIndexedAccess` oblige). */
function cell(index: number): HTMLInputElement {
  const found = cells()[index];
  if (!found) throw new Error(`case ${index} absente`);
  return found;
}

describe('OtpInput (M8)', () => {
  it('présente six cases numériques sous un même libellé', () => {
    mount();
    expect(screen.getByRole('group', { name: 'Code à 6 chiffres' })).toBeTruthy();
    expect(cells()).toHaveLength(6);
    for (const cell of cells()) {
      expect(cell.getAttribute('inputmode')).toBe('numeric');
      expect(cell.maxLength).toBe(1);
    }
  });

  it('saisit un chiffre puis avance le focus', () => {
    const state = mount();
    fireEvent.change(cell(0), { target: { value: '4' } });
    expect(state.value).toBe('4');
    expect(document.activeElement).toBe(cell(1));
  });

  it('ignore tout ce qui n’est pas un chiffre', () => {
    const state = mount();
    fireEvent.change(cell(0), { target: { value: 'ab7' } });
    expect(state.value).toBe('7');
  });

  it('accepte le collage du code complet', () => {
    const state = mount();
    fireEvent.paste(cell(0), { clipboardData: { getData: () => '482-190' } });
    expect(state.value).toBe('482190');
    expect(cells().every((c) => c.value !== '')).toBe(true);
  });

  it('revient en arrière sans effacer les autres cases', () => {
    const state = mount('482');
    cell(2).focus();
    fireEvent.keyDown(cell(2), { key: 'Backspace' });
    expect(state.value).toBe('48');
    expect(document.activeElement).toBe(cell(2));

    // Case vide : le chiffre précédent est effacé et le focus recule.
    fireEvent.keyDown(cell(2), { key: 'Backspace' });
    expect(state.value).toBe('4');
    expect(document.activeElement).toBe(cell(1));
  });

  it('signale l’erreur sur toutes les cases', () => {
    render(<OtpInput value="482190" onChange={() => {}} invalid />);
    for (const cell of cells()) expect(cell.getAttribute('aria-invalid')).toBe('true');
  });

  it('expose un conteneur pour reprendre le focus après une erreur', () => {
    const container: { current: HTMLDivElement | null } = { current: null };
    render(<OtpInput value="" onChange={() => {}} containerRef={container} />);
    expect(container.current?.querySelectorAll('input')).toHaveLength(6);
  });
});
