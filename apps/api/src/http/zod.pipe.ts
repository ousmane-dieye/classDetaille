import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiError } from './errors.js';

/** Validation d'un corps ou d'un paramètre : champs inconnus refusés (schémas stricts), aucune valeur recopiée. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    const fields = [...new Set(r.error.issues.map((i) => (i.path.length ? i.path.map(String).join('.') : '(body)')))];
    throw new ApiError(400, 'VALIDATION_FAILED', { fields });
  }
}
