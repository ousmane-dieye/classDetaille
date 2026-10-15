import type { ReactElement, ReactNode } from 'react';

export type StateScreenProps = {
  title: string;
  /** Icône décorative (les états portent aussi un texte et une couleur : jamais la couleur seule). */
  icon?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  tone?: 'neutral' | 'success' | 'error';
};

/** UX § 3.1 et M14 : un état = icône, titre, texte, actions. Un seul bloc, une colonne. */
export function StateScreen({ title, icon, children, actions, tone = 'neutral' }: StateScreenProps): ReactElement {
  return (
    <div className={`cp-state cp-state--${tone}`}>
      {icon ? (
        <div className="cp-state__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h1>{title}</h1>
      <div className="cp-state__body">{children}</div>
      {actions ? <div className="cp-state__actions">{actions}</div> : null}
    </div>
  );
}
