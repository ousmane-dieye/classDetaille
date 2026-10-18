/** Types des réponses de l'API (DTO du lot 1a et 1b) : le serveur fait foi, aucune copie locale. */

export type ClassSummary = { id: string; name: string; level: string; academicYear: string };

export type Enrollment = {
  id: string;
  // `CANCELLED` existe en base (anonymisation du compte) : un compte qui a subi cet effacement
  // ne rouvre plus aucune session, mais le type reste celui que le serveur peut produire.
  status: 'PENDING' | 'ACCEPTED' | 'REFUSED' | 'CANCELLED';
  class: ClassSummary | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Refus : date à partir de laquelle une nouvelle demande pour cette classe est possible (24 h). */
  retryAfter: string | null;
};

export type UserProfile = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  globalRole: 'USER' | 'ADMIN';
  emailReminders: boolean;
  emailAnnouncements: boolean;
};

/**
 * Appartenance active du compte (R9) : le libellé réunit nom, niveau et année de la classe —
 * jamais la liste des membres, jamais rien d'une autre classe.
 */
export type Membership = { classId: string; classLabel: string; role: 'STUDENT' | 'DELEGATE' };

export type Me = UserProfile & { enrollment: Enrollment | null; membership: Membership | null };

/** Demande en attente dans la file de la classe (M9) : le nom affiche l'adresse masquée (M8). */
export type EnrollmentRequest = {
  id: string;
  status: 'PENDING';
  createdAt: string;
  user: { firstName: string; lastName: string; email: string };
};

/** Membre actif de la classe (M9) : visibles des délégués de la classe et des administrateurs. */
export type ClassMember = {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  role: 'STUDENT' | 'DELEGATE';
  joinedAt: string;
};

/** Rôle après nomination ou révocation (M12). */
export type Delegate = { userId: string; role: 'STUDENT' | 'DELEGATE' };

/** Matière de la classe (R12). */
export type Subject = { id: string; name: string; createdAt: string };

/** Transfert simple (R7) : la personne et sa nouvelle classe. */
export type Transfer = { userId: string; toClassId: string };

/** Transfert en masse (R7) : tout ou rien, donc un seul compte rendu. */
export type TransferBatch = { transferred: number };

/** Ligne de la liste d'administration (M11) : statut et effectif. */
export type ClassAdminSummary = {
  id: string;
  name: string;
  level: string;
  academicYear: string;
  status: 'ACTIVE' | 'ARCHIVED';
  membersCount: number;
};

export type Session = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
};

/** Réponse `202` d'une connexion d'administrateur (§ 3.3). */
export type AdminCodeRequired = { status: 'ADMIN_CODE_REQUIRED'; expiresInSeconds: 600; resendAfterSeconds: 60 };
