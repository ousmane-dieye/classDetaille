/** Ligne SQL de la liste des membres (P8, écran M9). */
export type MemberRow = {
  userId: string; firstName: string; lastName: string; email: string;
  role: 'STUDENT' | 'DELEGATE'; joinedAt: Date;
};
/** Membre actif de la classe : emails visibles des délégués de la classe et des administrateurs. */
export type MemberDto = {
  userId: string; firstName: string; lastName: string; email: string;
  role: 'STUDENT' | 'DELEGATE'; joinedAt: string;
};
/** Nomination ou révocation (M12) : le rôle après l'action. */
export type DelegateDto = {
  userId: string; role: 'STUDENT' | 'DELEGATE';
};
/** Transfert simple (M13, R7) : la personne et sa nouvelle classe. */
export type TransferDto = {
  userId: string; toClassId: string;
};
/** Transfert en masse (M13, R7) : nombre d'étudiants transférés (tout ou rien). */
export type TransferBatchDto = {
  transferred: number;
};
