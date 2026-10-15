import type { FocusEventHandler, ReactElement } from 'react';

export type TextFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  type?: string;
  /** Aide sous le champ, toujours reliée au champ (aria-describedby). */
  hint?: string;
  /** Message d’erreur : annoncé immédiatement, relié au champ, jamais porté par la couleur seule. */
  error?: string;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'email';
  required?: boolean;
  onBlur?: FocusEventHandler<HTMLInputElement>;
};

/** UX § 3.1 « Saisie » : libellé visible, aide, erreur sous le champ. */
export function TextField({ id, label, value, onChange, type = 'text', hint, error, autoComplete, inputMode, required, onBlur }: TextFieldProps): ReactElement {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="cp-field">
      <label className="cp-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={error ? 'cp-input cp-input--error' : 'cp-input'}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        inputMode={inputMode}
        required={required}
        onBlur={onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {hint ? (
        <p className="cp-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="cp-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
