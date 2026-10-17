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
