import { describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ACTIONS, MATRIX, actorClass, can, type Action } from './matrix.js';

const ACTORS = {
  anonymous: { kind: 'anonymous', ip: '203.0.113.1' },
  user: { kind: 'user', userId: 'u', globalRole: 'USER', sessionId: 's' },
  admin: { kind: 'user', userId: 'a', globalRole: 'ADMIN', sessionId: 's' },
  cli: { kind: 'cli', command: 'create-admin' },
  system: { kind: 'system', job: 'email.send' },
} satisfies Record<string, Actor>;
type Name = keyof typeof ACTORS;

// Oracle indépendant, écrit à la main depuis la spec (§ 0.2, § 0.3, § 3) : NE JAMAIS le générer
// ni le dériver de MATRIX, sinon le test vérifierait la matrice contre elle-même.
const EXPECTED: Record<Action, readonly Name[]> = {
  'classes.listActive': ['anonymous', 'user', 'admin'],
  'auth.register': ['anonymous'],
  'auth.login': ['anonymous'],
  'auth.logout': ['user', 'admin'],
  'me.read': ['user', 'admin'],
  'me.updateProfile': ['user', 'admin'],
  'me.updatePreferences': ['user'],
  'me.changePassword': ['user', 'admin'],
  'me.listSessions': ['user', 'admin'],
  'me.revokeOtherSessions': ['user', 'admin'],
  'admin.createFirst': ['cli'],
  'classes.create': ['cli'],
  // Lot 1b.
  'auth.verifyCode': ['anonymous'],
  'auth.resendCode': ['anonymous'],
  'auth.verifyRecovery': ['anonymous'],
  'auth.forgotPassword': ['anonymous'],
  'auth.resetPassword': ['anonymous'],
  'me.reauth': ['user', 'admin'],
  'me.stepUp': ['admin'],
  'me.stepUpVerify': ['admin'],
  'stepUp.assertFresh': ['admin'],
  'reauth.assertRecent': ['user', 'admin'],
  'me.changeEmailStart': ['admin'],
  'me.changeEmailVerifyOld': ['admin'],
  'me.changeEmailVerifyNew': ['admin'],
  'mail.enqueue': ['anonymous', 'user', 'admin', 'system'],
  'mail.deliver': ['system'],
  'mail.sweep': ['system'],
  'maintenance.purge': ['system'],
};

describe('matrice d’autorisation (§ 5.4 : 100 %)', () => {
  it('chaque action de la matrice a une attente, et inversement', () => {
    expect([...ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(MATRIX).sort()).toEqual([...ACTIONS].sort());
  });
  for (const action of ACTIONS) {
    for (const name of Object.keys(ACTORS) as Name[]) {
      const allowed = EXPECTED[action].includes(name);
      it(`${action} × ${name} → ${allowed ? 'autorisé' : 'refusé'}`, () => {
        expect(can(ACTORS[name], action)).toBe(allowed);
      });
    }
  }
  it('la classe system n’a que les quatre actions du worker', () => {
    const sys = ACTIONS.filter((a) => MATRIX[a].includes('system')).sort();
    expect(sys).toEqual(['mail.deliver', 'mail.enqueue', 'mail.sweep', 'maintenance.purge']);
  });
  it('actorClass distingue l’administrateur de l’étudiant', () => {
    expect(actorClass(ACTORS.admin)).toBe('admin');
    expect(actorClass(ACTORS.user)).toBe('user');
  });
});
