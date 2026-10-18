import type { EnrollmentDto } from '../memberships/enrollment.dto.js';
import type { UserProfileDto } from './user.dto.js';

/**
 * Appartenance active du compte (R9) : le libellé réunit nom, niveau et année, tout ce que
 * l'écran « Ma classe » affiche — jamais la liste des membres ni aucune donnée d'une autre classe.
 */
export type MembershipDto = { classId: string; classLabel: string; role: 'STUDENT' | 'DELEGATE' };

export type MeDto = UserProfileDto & { enrollment: EnrollmentDto | null; membership: MembershipDto | null };
