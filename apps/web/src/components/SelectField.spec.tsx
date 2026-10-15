import type { ComponentProps } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectField } from './SelectField';

afterEach(cleanup);

const options = [
  { value: 'c1', label: 'GIT3 · 2026-2027' },
  { value: 'c2', label: 'M1 Génie logiciel · 2026-2027' },
];

function mount(props: Partial<ComponentProps<typeof SelectField>> = {}): void {
  render(<SelectField id="classId" label="Ta classe" value="" onChange={vi.fn()} options={options} {...props} />);
}

describe('SelectField', () => {
  it('a un libellé visible lié au champ et une première option vide', () => {
    mount();
    const select = screen.getByLabelText('Ta classe') as HTMLSelectElement;
    expect(select.id).toBe('classId');
    expect(select.options[0]?.textContent).toContain('Choisis');
    expect([...select.options].map((o) => o.textContent)).toContain('GIT3 · 2026-2027');
  });

  it('annonce l’erreur et la lie au champ', () => {
    mount({ error: 'Choisis une classe pour continuer.' });
    const select = screen.getByLabelText('Ta classe');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('Choisis une classe');
  });
});
