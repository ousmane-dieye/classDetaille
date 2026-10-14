import type { ClassSummaryDto } from '../classes/class.dto.js';

export type EnrollmentRow = {
  id: string; status: 'PENDING' | 'ACCEPTED' | 'REFUSED'; classId: string;
  createdAt: Date; decidedAt: Date | null; decisionNote: string | null;
};
export type EnrollmentDto = {
  id: string; status: 'PENDING' | 'ACCEPTED' | 'REFUSED'; class: ClassSummaryDto | null;
  createdAt: string; decidedAt: string | null; decisionNote: string | null;
  /** Refus : date à partir de laquelle une nouvelle demande pour cette classe est possible (24 h, § 0.3). */
  retryAfter: string | null;
};
