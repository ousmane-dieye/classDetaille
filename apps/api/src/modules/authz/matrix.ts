import type { Actor } from './actor.js';

export const ACTIONS = [
  'classes.listActive', 'auth.register', 'auth.login', 'auth.logout',
  'me.read', 'me.updateProfile', 'me.updatePreferences', 'me.changePassword', 'me.listSessions', 'me.revokeOtherSessions',
  'admin.createFirst', 'classes.create',
  'auth.verifyCode', 'auth.resendCode', 'auth.verifyRecovery', 'auth.forgotPassword', 'auth.resetPassword',
  'me.reauth', 'me.stepUp', 'me.stepUpVerify', 'stepUp.assertFresh', 'reauth.assertRecent',
  'me.changeEmailStart', 'me.changeEmailVerifyOld', 'me.changeEmailVerifyNew',
  // Lot 2 : décisions d'adhésion (P8) et re-demande d'un compte existant (R16).
  'memberships.listRequests', 'memberships.accept', 'memberships.refuse', 'memberships.listMembers', 'memberships.remove', 'memberships.appointDelegate', 'memberships.revokeDelegate', 'me.createEnrollment',
  // Lot 2 : matières de la classe (R12) — portée délégué/admin affinée en service.
  'classes.listSubjects', 'classes.createSubject', 'classes.deleteSubject',
  // Lot 2 : administration des classes (M11/M12) — liste et création réservées à l'admin.
  'classes.list', 'classes.createApp', 'classes.read', 'classes.archive',
  'mail.enqueue', 'mail.deliver', 'mail.sweep', 'maintenance.purge', 'jobs.lease',
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
  // Lot 2 : l'appartenance (délégation, classe) est affinée par le service, pas par la matrice (R2).
  'memberships.listRequests': ['user', 'admin'],
  'memberships.accept': ['user', 'admin'],
  'memberships.refuse': ['user', 'admin'],
  'memberships.listMembers': ['user', 'admin'],
  // Retrait : délégué de la classe (affiné : étudiants seulement), admin ; le mot de passe récent est exigé en service.
  'memberships.remove': ['user', 'admin'],
  // Délégation (M12) : réservée à l'administrateur ; la limite de deux vit en base (déclencheur delegate_limit, R8).
  'memberships.appointDelegate': ['admin'],
  'memberships.revokeDelegate': ['admin'],
  'me.createEnrollment': ['user'],
  // Matières (R12) : tout utilisateur authentifié, affiné en service (délégué de la classe ou admin).
  'classes.listSubjects': ['user', 'admin'],
  'classes.createSubject': ['user', 'admin'],
  'classes.deleteSubject': ['user', 'admin'],
  // Administration des classes (M11/M12) : liste et création réservées à l'admin ;
  // la lecture est ouverte aux membres, affinée en service (appartenance active ou admin, sinon 404).
  'classes.list': ['admin'],
  'classes.createApp': ['admin'],
  'classes.read': ['user', 'admin'],
  'classes.archive': ['admin'],
  'mail.enqueue': ['anonymous', 'user', 'admin', 'system'],
  'mail.deliver': ['system'],
  'mail.sweep': ['system'],
  'maintenance.purge': ['system'],
  'jobs.lease': ['system'],
};

export function actorClass(a: Actor): ActorClass {
  if (a.kind === 'user') return a.globalRole === 'ADMIN' ? 'admin' : 'user';
  return a.kind;
}

export function can(actor: Actor, action: Action): boolean {
  return MATRIX[action].includes(actorClass(actor));
}
