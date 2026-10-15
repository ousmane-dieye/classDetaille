import type { ReactElement } from 'react';

/**
 * M14 : bandeau global « Connexion perdue — reconnexion… ». Il n'empêche rien — la consultation
 * reste possible — mais dit pourquoi une écriture pourrait échouer (§ 3.1, jamais la couleur seule).
 */
export function Banner({ online }: { online: boolean }): ReactElement | null {
  if (online) return null;
  return (
    <div className="cp-banner" role="status">
      Connexion perdue — reconnexion…
    </div>
  );
}
