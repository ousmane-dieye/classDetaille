import type { Actor } from './actor.js';

export const ACTIONS = [
  'classes.listActive', 'auth.register', 'auth.login', 'auth.logout',
  'me.read', 'me.updateProfile', 'me.updatePreferences', 'me.changePassword', 'me.listSessions', 'me.revokeOtherSessions',
  'admin.createFirst', 'classes.create',
] as const;
export type Action = (typeof ACTIONS)[number];
export type ActorClass = 'anonymous' | 'user' | 'admin' | 'cli';

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
};

export function actorClass(a: Actor): ActorClass {
  if (a.kind === 'user') return a.globalRole === 'ADMIN' ? 'admin' : 'user';
  return a.kind;
}

export function can(actor: Actor, action: Action): boolean {
  return MATRIX[action].includes(actorClass(actor));
}
