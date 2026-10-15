/** Types des réponses de l'API (DTO du lot 1a et 1b) : le serveur fait foi, aucune copie locale. */

export type ClassSummary = { id: string; name: string; level: string; academicYear: string };

export type Enrollment = {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REFUSED';
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

export type Me = UserProfile & { enrollment: Enrollment | null };

export type Session = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
};

/** Réponse `202` d'une connexion d'administrateur (§ 3.3). */
export type AdminCodeRequired = { status: 'ADMIN_CODE_REQUIRED'; expiresInSeconds: 600; resendAfterSeconds: 60 };
