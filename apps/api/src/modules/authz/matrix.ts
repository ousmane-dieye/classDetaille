import type { Actor } from './actor.js';

export const ACTIONS = [
  'classes.listActive', 'auth.register', 'auth.login', 'auth.logout',
  'me.read', 'me.updateProfile', 'me.updatePreferences', 'me.changePassword', 'me.listSessions', 'me.revokeOtherSessions',
  'admin.createFirst', 'classes.create',
  'auth.verifyCode', 'auth.resendCode', 'auth.verifyRecovery', 'auth.forgotPassword', 'auth.resetPassword',
  'me.reauth', 'me.stepUp', 'me.stepUpVerify', 'stepUp.assertFresh', 'reauth.assertRecent',
  'me.changeEmailStart', 'me.changeEmailVerifyOld', 'me.changeEmailVerifyNew',
  'mail.enqueue', 'mail.deliver', 'mail.sweep', 'maintenance.purge',
] as const;
export type Action = (typeof ACTIONS)[number];
export type ActorClass = 'anonymous' | 'user' | 'admin' | 'cli' | 'system';

/** Matrice des droits (§ 1.3 : reprise de la section D, corrigée par la spec). Chaque lot y ajoute ses actions. */
export const MATRIX: Record<Action, readonly ActorClass[]> = {
  'classes.listActive': ['anonymous', 'user', 'admin'],
  'auth.register': ['anonymous'],
  'auth.login': ['anonymous'],
  'auth.logout': ['user', 'admin'],
  'me.read': ['user', 'admin'],
  'me.updateProfile': ['user', 'admin'],
  // Un administrateur ne reçoit que les notifications d'administration (§ 0.2) : pas de préférences de rappels.
  'me.updatePreferences': ['user'],
  'me.changePassword': ['user', 'admin'],
  'me.listSessions': ['user', 'admin'],
  'me.revokeOtherSessions': ['user', 'admin'],
  'admin.createFirst': ['cli'],
  'classes.create': ['cli'],
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

export function actorClass(a: Actor): ActorClass {
  if (a.kind === 'user') return a.globalRole === 'ADMIN' ? 'admin' : 'user';
  return a.kind;
}

export function can(actor: Actor, action: Action): boolean {
  return MATRIX[action].includes(actorClass(actor));
}
