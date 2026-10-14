import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'cp:isPublic';
/** Route accessible sans session. Toutes les autres exigent une session valide (garde global, refus par défaut). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
