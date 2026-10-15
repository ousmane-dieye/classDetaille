import type { ReactElement, ReactNode } from 'react';
import { AlertIcon } from './icons';

export type InlineAlertProps = {
  tone?: 'error' | 'info';
  children?: ReactNode;
};

/** UX § 3.1 « Retours » : message court, annoncé poliment, avec icône et texte (jamais la couleur seule). */
export function InlineAlert({ tone = 'error', children }: InlineAlertProps): ReactElement | null {
  if (!children) return null;
  return (
    <p className={`cp-alert cp-alert--${tone}`} role="alert">
      <AlertIcon className="cp-alert__icon" />
      <span>{children}</span>
    </p>
  );
}
