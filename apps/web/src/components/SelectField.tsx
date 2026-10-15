import type { ReactElement } from 'react';

export type SelectOption = { value: string; label: string };

export type SelectFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  options: readonly SelectOption[];
  error?: string;
  placeholder?: string;
};

/** UX § 3.1 « Saisie » : liste déroulante native, libellé visible, erreur reliée au champ. */
export function SelectField({ id, label, value, onChange, options, error, placeholder = 'Choisis une classe' }: SelectFieldProps): ReactElement {
  return (
    <div className="cp-field">
      <label className="cp-field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={error ? 'cp-input cp-input--error' : 'cp-input'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <p className="cp-field__error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
