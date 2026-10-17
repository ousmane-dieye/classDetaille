import { describe, expect, it } from 'vitest';
import { CreateClassBody, CreateSubjectBody } from './class-schemas.js';

describe('CreateSubjectBody', () => {
  it('nom exigé, borné structurellement, aucun champ inconnu', () => {
    expect(CreateSubjectBody.safeParse({ name: 'Algorithmique' }).success).toBe(true);
    expect(CreateSubjectBody.safeParse({}).success).toBe(false);
    expect(CreateSubjectBody.safeParse({ name: '' }).success).toBe(false);
    expect(CreateSubjectBody.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    expect(CreateSubjectBody.safeParse({ name: 'Maths', id: 'x' }).success).toBe(false);
  });
});

describe('CreateClassBody', () => {
  it('nom, niveau et année exigés, bornés structurellement, aucun champ inconnu', () => {
    expect(CreateClassBody.safeParse({ name: 'L1 Informatique', level: 'L1', academicYear: '2026-2027' }).success).toBe(true);
    expect(CreateClassBody.safeParse({ name: 'L1 Informatique', level: 'L1' }).success).toBe(false);
    expect(CreateClassBody.safeParse({ name: '', level: 'L1', academicYear: '2026-2027' }).success).toBe(false);
    expect(CreateClassBody.safeParse({ name: 'L1', level: '', academicYear: '2026-2027' }).success).toBe(false);
    expect(CreateClassBody.safeParse({ name: 'L1', level: 'L1', academicYear: '2026-2027', status: 'ACTIVE' }).success).toBe(false);
  });
});
