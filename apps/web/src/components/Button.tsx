import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'link' | 'danger';

export type ButtonProps = {
  children: ReactNode;
  variant?: ButtonVariant;
  /** Envoi en cours : le bouton est inutilisable et le signale aux lecteurs d’écran. */
  busy?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>;

/** UX § 4.5 : principal (terre cuite plein), secondaire (trait appuyé), lien, destructif. */
export function Button({ children, variant = 'primary', busy = false, disabled, type = 'button', ...rest }: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={`cp-btn cp-btn--${variant}`}
      aria-busy={busy || undefined}
      disabled={busy || disabled}
      {...rest}
    >
      {busy ? <span className="cp-btn__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
