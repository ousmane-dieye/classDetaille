export type ClassSummaryDto = { id: string; name: string; level: string; academicYear: string };

/** Ligne SQL d'une matière (R12). */
export type SubjectRow = { id: string; name: string; createdAt: Date };

/** Matière de la classe (P8, écran M9). */
export type SubjectDto = { id: string; name: string; createdAt: string };

/** Ligne SQL de la liste admin (M11) : statut et effectif. */
export type ClassAdminRow = { id: string; name: string; level: string; academicYear: string; status: 'ACTIVE' | 'ARCHIVED'; membersCount: number };

/** Vue admin de toutes les classes (M11) : archivées incluses, badge « Lecture seule ». */
export type ClassAdminSummaryDto = ClassAdminRow;

/** Ligne SQL de la fiche (M12) : classe + statistiques simples (R11). */
export type ClassDetailRow = {
  id: string; name: string; level: string; academicYear: string; status: 'ACTIVE' | 'ARCHIVED'; archivedAt: Date | null;
  members: number; pendingRequests: number; decidedRequests: number;
};

/** Statistiques simples (R11) : membres actifs, demandes en attente, demandes traitées. */
export type ClassStatsDto = { members: number; pendingRequests: number; decidedRequests: number };

/** Fiche de la classe (M12, R11). */
export type ClassDetailDto = Omit<ClassDetailRow, 'archivedAt' | 'members' | 'pendingRequests' | 'decidedRequests'> & {
  archivedAt: string | null;
  stats: ClassStatsDto;
};

/** Archivage (M13) : statut après l'action. */
export type ClassArchiveDto = { id: string; status: 'ARCHIVED' };

/** Création in-app (R8, admin) : la classe naît ACTIVE. */
export type ClassCreateDto = { id: string; name: string; level: string; academicYear: string; status: 'ACTIVE' };
