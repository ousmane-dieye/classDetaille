/** Acteur authentifié par une session. Un administrateur n'est membre d'aucune classe (§ 0.2). */
export type UserActor = { kind: 'user'; userId: string; globalRole: 'USER' | 'ADMIN'; sessionId: string };
/** Parcours avant authentification (R1). L'IP sert aux limitations, jamais à l'audit. */
export type AnonymousActor = { kind: 'anonymous'; ip: string };
/** Commandes en ligne (R1). */
export type CliActor = { kind: 'cli'; command: 'create-admin' | 'create-class' };
/** Traitements du worker (R1 du lot 1b). */
export type SystemActor = { kind: 'system'; job: 'email.send' | 'maintenance.purge' };
export type Actor = UserActor | AnonymousActor | CliActor | SystemActor;
