import { useState } from 'react';
import type { ReactElement } from 'react';

export type PasswordFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  autoComplete: 'new-password' | 'current-password';
  /** Indicateur de longueur « N caractères · 15 minimum », sans jauge de force (UX P1). */
  minimum?: number;
  hint?: string;
  error?: string;
  required?: boolean;
  onBlur?: () => void;
};

/** UX § 3.1 et P1 : champ de mot de passe masqué par défaut, bouton « Afficher », longueur indiquée. */
export function PasswordField({ id, label, value, onChange, autoComplete, minimum, hint, error, required, onBlur }: PasswordFieldProps): ReactElement {
  const [visible, setVisible] = useState(false);
  const hintId = hint ? `${id}-hint` : undefined;
  const lengthId = minimum !== undefined ? `${id}-length` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, lengthId, errorId].filter(Boolean).join(' ') || undefined;
  const length = [...value].length;
  const shortBy = minimum === undefined ? 0 : minimum - length;

  return (
    <div className="cp-field">
      <div className="cp-field__labelrow">
        <label className="cp-field__label" htmlFor={id}>
          {label}
        </label>
        <button type="button" className="cp-linkbtn" aria-pressed={visible} onClick={() => setVisible((v) => !v)}>
          {visible ? 'Masquer' : 'Afficher'}
        </button>
      </div>
      <input
        id={id}
        className={error ? 'cp-input cp-input--error' : 'cp-input'}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
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
      {minimum !== undefined ? (
        <p className={length > 0 && shortBy > 0 ? 'cp-field__hint cp-field__hint--short' : 'cp-field__hint'} id={lengthId}>
          {length === 0 ? (
            <>
              <b>{minimum}</b> caractères minimum
            </>
          ) : shortBy > 0 ? (
            <>
              <b>{length}</b> caractères · encore {shortBy} pour atteindre {minimum}
            </>
          ) : (
            <>
              <b>{length}</b> caractères · {minimum} minimum
            </>
          )}
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
