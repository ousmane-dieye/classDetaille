import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AnonymousActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { UsersService } from '../users/users.service.js';
import type { ClientContext } from './client-context.js';
import { hashSessionToken, newSessionToken, ADMIN_ABSOLUTE_SECONDS, ADMIN_IDLE_SECONDS, STUDENT_SESSION_SECONDS } from './session-cookie.js';
import { SessionsRepository } from './sessions.repository.js';

export type OpenedSession = { token: string; maxAgeSeconds: number; actor: UserActor };
export type SessionDto = { id: string; createdAt: string; lastSeenAt: string; userAgent: string | null; current: boolean };

@Injectable()
export class SessionsService {
  constructor(
    @Inject(SessionsRepository) private readonly repo: SessionsRepository,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * Nouveau jeton à chaque connexion (§ 3.4). Au lot 1a, seuls les comptes USER ouvrent une session (R2).
   * Appelée à l'inscription et à la connexion, toutes deux réservées à l'acteur anonyme dans la matrice
   * (`auth.register` et `auth.login` ont les mêmes acteurs) : on vérifie `auth.login`.
   */
  async openInTx(tx: TxClient, actor: AnonymousActor, user: { id: string; globalRole: 'USER' }, ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.login');
    const { token, hash } = newSessionToken();
    const id = uuidv7();
    await this.repo.createInTx(tx, {
      id, tokenHash: hash, userId: user.id,
      idleSeconds: STUDENT_SESSION_SECONDS, absoluteSeconds: STUDENT_SESSION_SECONDS,
      ip: ctx.ip, userAgent: ctx.userAgent, secondFactorMethod: null,
    });
    return { token, maxAgeSeconds: STUDENT_SESSION_SECONDS, actor: { kind: 'user', userId: user.id, globalRole: user.globalRole, sessionId: id } };
  }

  /** Session d'administrateur (§ 3.3, R10) ; l'appelant a verrouillé la ligne users et vérifié ACTIVE + ADMIN (checkInTx) dans la même transaction. Créée seulement après le code (ou le code de récupération). */
  async openAdminInTx(tx: TxClient, actor: AnonymousActor, user: { id: string }, method: 'EMAIL_CODE' | 'RECOVERY_CODE', ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.verifyCode');
    const { token, hash } = newSessionToken();
    const id = uuidv7();
    await this.repo.createInTx(tx, { id, tokenHash: hash, userId: user.id, idleSeconds: ADMIN_IDLE_SECONDS, absoluteSeconds: ADMIN_ABSOLUTE_SECONDS, ip: ctx.ip, userAgent: ctx.userAgent, secondFactorMethod: method });
    return { token, maxAgeSeconds: ADMIN_ABSOLUTE_SECONDS, actor: { kind: 'user', userId: user.id, globalRole: 'ADMIN', sessionId: id } };
  }

  /**
   * Primitive d'authentification, sans Actor (extension de R13, avec UsersService.activeRoleOf) :
   * c'est elle qui construit l'acteur à partir du cookie. Le serveur fait foi :
   * session révoquée, expirée ou compte non ACTIVE → null.
   */
  async authenticate(token: string): Promise<UserActor | null> {
    const hash = hashSessionToken(token);
    if (!hash) return null;
    const s = await this.repo.findValid(hash);
    if (!s) return null;
    const state = await this.users.authStateOf(s.userId);
    if (!state) return null;
    if ('revokeReason' in state) {
      // Le cookie d'un compte non ACTIVE ne redevient jamais valide, même si le compte est réactivé ensuite.
      await this.repo.revoke(s.sessionId, state.revokeReason);
      return null;
    }
    const role = state.role;
    if (s.stale) await this.repo.touch(s.sessionId, role === 'ADMIN' ? ADMIN_IDLE_SECONDS : STUDENT_SESSION_SECONDS);
    return { kind: 'user', userId: s.userId, globalRole: role, sessionId: s.sessionId };
  }

  async logout(actor: UserActor): Promise<void> {
    this.authz.assert(actor, 'auth.logout');
    await this.repo.revoke(actor.sessionId, 'LOGOUT');
  }

  async list(actor: UserActor): Promise<SessionDto[]> {
    this.authz.assert(actor, 'me.listSessions');
    const rows = await this.repo.listActive(actor.userId);
    return rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(), userAgent: r.userAgent, current: r.id === actor.sessionId }));
  }

  async revokeOthers(actor: UserActor): Promise<number> {
    this.authz.assert(actor, 'me.revokeOtherSessions');
    return this.prisma.withTx(async (tx) => {
      const count = await this.repo.revokeOthersInTx(tx, actor.userId, actor.sessionId, 'OTHER_DEVICES');
      await this.audit.recordInTx(tx, actor, { action: 'SESSIONS_REVOKED', targetType: 'USER', targetId: actor.userId, metadata: { reason: 'OTHER_DEVICES', count } });
      return count;
    });
  }

  async revokeOthersInTx(tx: TxClient, actor: UserActor, reason: 'PASSWORD_CHANGED'): Promise<number> {
    this.authz.assert(actor, 'me.changePassword');
    return this.repo.revokeOthersInTx(tx, actor.userId, actor.sessionId, reason);
  }

  async markReauthInTx(tx: TxClient, actor: UserActor): Promise<void> {
    this.authz.assert(actor, 'me.changePassword');
    await this.repo.markReauthInTx(tx, actor.sessionId);
  }
}
