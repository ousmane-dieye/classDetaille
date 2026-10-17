import { describe, expect, it } from 'vitest';
import { CreateSubjectBody } from './class-schemas.js';

describe('CreateSubjectBody', () => {
  it('nom exigé, borné structurellement, aucun champ inconnu', () => {
    expect(CreateSubjectBody.safeParse({ name: 'Algorithmique' }).success).toBe(true);
    expect(CreateSubjectBody.safeParse({}).success).toBe(false);
    expect(CreateSubjectBody.safeParse({ name: '' }).success).toBe(false);
    expect(CreateSubjectBody.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    expect(CreateSubjectBody.safeParse({ name: 'Maths', id: 'x' }).success).toBe(false);
  });
});
