import type { ReactElement, ReactNode } from 'react';

export type AuthShellProps = {
  title: string;
  /** Une phrase sous le titre (« Ton délégué validera ta demande… »). */
  lead?: string;
  /** Phrase du panneau de marque, à gauche sur ordinateur (M7/M8). */
  claim: string;
  claimDetail: string;
  children: ReactNode;
  /** Lien de bas de formulaire (« Déjà un compte ? Se connecter »). */
  footer?: ReactNode;
};

/**
 * M7 et M8 : panneau de marque à gauche, formulaire à droite.
 * R7 : la photo d'étudiants n'est pas encore fournie — l'emplacement est prévu, sans image d'attente.
 * Sur mobile, pas de photo et pas de panneau : le formulaire tient seul.
 */
export function AuthShell({ title, lead, claim, claimDetail, children, footer }: AuthShellProps): ReactElement {
  return (
    <div className="cp-auth">
      <aside className="cp-auth__brand">
        <p className="cp-auth__wm">
          Classe<span>Pulse</span>
        </p>
        <h2 className="cp-auth__claim">{claim}</h2>
        <p className="cp-auth__sub">{claimDetail}</p>
      </aside>
      <div className="cp-auth__panel">
        <p className="cp-auth__wm cp-auth__wm--mobile">
          Classe<span>Pulse</span>
        </p>
        <h1>{title}</h1>
        {lead ? <p className="cp-auth__lead">{lead}</p> : null}
        {children}
        {footer ? <div className="cp-auth__alt">{footer}</div> : null}
      </div>
    </div>
  );
}
