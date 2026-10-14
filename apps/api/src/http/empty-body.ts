import { z } from 'zod';

/** Corps des routes modifiantes qui n'en attendent aucun : tout champ est refusé (400), comme pour les autres routes. */
export const EmptyBody = z.strictObject({}).optional();
