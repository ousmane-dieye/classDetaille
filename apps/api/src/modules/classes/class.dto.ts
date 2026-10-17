export type ClassSummaryDto = { id: string; name: string; level: string; academicYear: string };

/** Ligne SQL d'une matière (R12). */
export type SubjectRow = { id: string; name: string; createdAt: Date };

/** Matière de la classe (P8, écran M9). */
export type SubjectDto = { id: string; name: string; createdAt: string };
