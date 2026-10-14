import type { EnrollmentDto } from '../memberships/enrollment.dto.js';
import type { UserProfileDto } from './user.dto.js';

export type MeDto = UserProfileDto & { enrollment: EnrollmentDto | null };
