import { describe, expect, it } from 'vitest';
import { CreateEnrollmentBody, RefuseEnrollmentBody, RemoveMemberBody } from './membership-schemas.js';

const CLASS_ID = '6f0d8f9e-1f3a-4a0b-9f1a-2f7e0a3c5d10';

describe('RefuseEnrollmentBody', () => {
  it('motif facultatif, borné à 500 caractères, blancs inutiles retirés', () => {
    expect(RefuseEnrollmentBody.safeParse({}).success).toBe(true);
    expect(RefuseEnrollmentBody.safeParse({ note: 'Classe complète' }).success).toBe(true);
    expect(RefuseEnrollmentBody.safeParse({ note: 'x'.repeat(500) }).success).toBe(true);
    expect(RefuseEnrollmentBody.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
    expect(RefuseEnrollmentBody.safeParse({ note: '   ' }).success).toBe(false);
    expect(RefuseEnrollmentBody.parse({ note: ' Classe complète ' })).toEqual({ note: 'Classe complète' });
  });

  it('aucun champ inconnu accepté', () => {
    expect(RefuseEnrollmentBody.safeParse({ note: 'x', decidedBy: 'autre' }).success).toBe(false);
  });
});

describe('RemoveMemberBody', () => {
  it('même motif facultatif et même borne que le retrait en base (1 à 500)', () => {
    expect(RemoveMemberBody.safeParse({}).success).toBe(true);
    expect(RemoveMemberBody.safeParse({ note: 'Ne vient plus en cours' }).success).toBe(true);
    expect(RemoveMemberBody.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
    expect(RemoveMemberBody.safeParse({ note: '   ' }).success).toBe(false);
    expect(RemoveMemberBody.safeParse({ note: 'x', by: 'autre' }).success).toBe(false);
  });
});

describe('CreateEnrollmentBody', () => {
  it('classe exigée, sous forme d’uuid', () => {
    expect(CreateEnrollmentBody.safeParse({ classId: CLASS_ID }).success).toBe(true);
    expect(CreateEnrollmentBody.safeParse({}).success).toBe(false);
    expect(CreateEnrollmentBody.safeParse({ classId: 'pas-un-uuid' }).success).toBe(false);
    expect(CreateEnrollmentBody.safeParse({ classId: CLASS_ID, extra: 1 }).success).toBe(false);
  });
});
