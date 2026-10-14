import { describe, expect, it } from 'vitest';
import { ChangePasswordBody, LoginBody, RegisterBody, UpdatePreferencesBody, UpdateProfileBody } from './identity-schemas.js';

const register = {
  firstName: 'Awa',
  lastName: 'Diop',
  email: ' Awa.Diop@Example.com ',
  password: 'une phrase de passe assez longue',
  classId: '0192b1c4-5d6e-7f80-9a1b-2c3d4e5f6a7b',
  turnstileToken: 'tok',
};

describe('schémas d’identité', () => {
  it('RegisterBody normalise l’email et le nom', () => {
    const r = RegisterBody.parse({ ...register, firstName: '  Awa ' });
    expect(r.email).toBe('awa.diop@example.com');
    expect(r.firstName).toBe('Awa');
  });
  it('RegisterBody normalise un email en pleine largeur', () => {
    const r = RegisterBody.parse({ ...register, email: '\uFF41\uFF4C\uFF49\uFF43\uFF45@example.com' });
    expect(r.email).toBe('alice@example.com');
  });
  it('refuse un champ inconnu', () => {
    expect(RegisterBody.safeParse({ ...register, role: 'ADMIN' }).success).toBe(false);
  });
  it('refuse un classId qui n’est pas un UUID', () => {
    expect(RegisterBody.safeParse({ ...register, classId: '1' }).success).toBe(false);
  });
  it('refuse un email non ASCII après normalisation', () => {
    expect(RegisterBody.safeParse({ ...register, email: '\u00E9lise@example.com' }).success).toBe(false);
  });
  it('refuse un nom de 1 ou de 81 caractères', () => {
    expect(RegisterBody.safeParse({ ...register, lastName: 'D' }).success).toBe(false);
    expect(RegisterBody.safeParse({ ...register, lastName: 'D'.repeat(81) }).success).toBe(false);
    expect(RegisterBody.safeParse({ ...register, lastName: 'D'.repeat(80) }).success).toBe(true);
  });
  it('compte les noms en points de code : un emoji seul est refusé, deux sont acceptés', () => {
    expect(RegisterBody.safeParse({ ...register, lastName: '\u{1F600}' }).success).toBe(false);
    expect(RegisterBody.safeParse({ ...register, lastName: '\u{1F600}\u{1F600}' }).success).toBe(true);
    expect(RegisterBody.safeParse({ ...register, lastName: '\u{1F600}'.repeat(80) }).success).toBe(true);
    expect(RegisterBody.safeParse({ ...register, lastName: '\u{1F600}'.repeat(81) }).success).toBe(false);
  });
  it('refuse les caractères de contrôle et de format dans un nom', () => {
    expect(RegisterBody.safeParse({ ...register, lastName: 'Di\u0000op' }).success).toBe(false);
    expect(RegisterBody.safeParse({ ...register, lastName: 'Di\u200Bop' }).success).toBe(false);
  });
  it('LoginBody : turnstileToken facultatif, mot de passe limité à 1024 caractères bruts', () => {
    expect(LoginBody.safeParse({ email: 'a@example.com', password: 'x' }).success).toBe(true);
    expect(LoginBody.safeParse({ email: 'a@example.com', password: 'x', turnstileToken: 't' }).success).toBe(true);
    const tooLong = LoginBody.safeParse({ email: 'a@example.com', password: 'x'.repeat(1025) });
    expect(tooLong.success).toBe(false);
    expect(!tooLong.success && tooLong.error.issues.map((i) => i.message)).toEqual(['PASSWORD_TOO_LONG']);
  });
  it('UpdatePreferencesBody exige au moins un champ', () => {
    expect(UpdatePreferencesBody.safeParse({}).success).toBe(false);
    expect(UpdatePreferencesBody.safeParse({ emailReminders: false }).success).toBe(true);
    expect(UpdatePreferencesBody.safeParse({ emailAnnouncements: true }).success).toBe(true);
  });
  it('UpdateProfileBody et ChangePasswordBody sont stricts', () => {
    expect(UpdateProfileBody.safeParse({ firstName: 'Awa', lastName: 'Diop' }).success).toBe(true);
    expect(UpdateProfileBody.safeParse({ firstName: 'Awa', lastName: 'Diop', email: 'x@y.sn' }).success).toBe(false);
    expect(ChangePasswordBody.safeParse({ currentPassword: 'a', newPassword: 'b' }).success).toBe(true);
    expect(ChangePasswordBody.safeParse({ currentPassword: 'a', newPassword: 'b', x: 1 }).success).toBe(false);
  });
});
