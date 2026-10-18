import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { dbMessageOf, isUniqueViolation } from '../../database/errors.js';
import { ApiError } from '../../http/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { AnonymousActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { FreshnessService } from '../authz/freshness.service.js';
import { ClassesService } from '../classes/classes.service.js';
import { MailService } from '../mail/mail.service.js';
import type { AcceptDecisionDto, EnrollmentDto, EnrollmentRow, RequestDto } from './enrollment.dto.js';
import type { DelegateDto, MemberDto, TransferBatchDto, TransferDto } from './member.dto.js';
import { MembershipsRepository } from './memberships.repository.js';

const REFUSAL_RETRY_MS = 24 * 3600 * 1000;
const REFUSAL_EMAIL_TTL_S = 7 * 24 * 3600;
/** Seuil du transfert en masse (R7) : au-delà, plusieurs appels (`400 BATCH_TOO_LARGE`). */
const MASS_TRANSFER_MAX = 200;
const UUID = z.uuid();

@Injectable()
export class MembershipsService {
  constructor(
    @Inject(MembershipsRepository) private readonly repo: MembershipsRepository,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ClassesService) private readonly classes: ClassesService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(FreshnessService) private readonly freshness: FreshnessService,
  ) {}

  /** Demande d'adhésion créée dans la transaction de l'inscription (§ 0.3). */
  async createRequestInTx(tx: TxClient, actor: AnonymousActor, input: { userId: string; classId: string }): Promise<string> {
    this.authz.assert(actor, 'auth.register');
    const id = uuidv7();
    await this.repo.createRequestInTx(tx, { id, ...input });
    return id;
  }

  async latestRequestOf(actor: UserActor): Promise<EnrollmentRow | null> {
    this.authz.assert(actor, 'me.read');
    return this.repo.latestForUser(actor.userId);
  }

  /** Nouvelle demande d'un compte existant (R16) : délai de 24 h et absence d'appartenance sont portés par la base. */
  async createEnrollment(actor: UserActor, classId: string): Promise<EnrollmentDto> {
    this.authz.assert(actor, 'me.createEnrollment');
    try {
      await this.prisma.withTx(async (tx) => {
        // Verrou partagé comme l'inscription : la base sérialise demandes et décisions (§ 2.1).
        const cls = await this.repo.lockClassInTx(tx, classId, false);
        if (!cls || cls.status !== 'ACTIVE') throw new ApiError(400, 'CLASS_NOT_AVAILABLE');
        const id = uuidv7();
        await this.repo.createRequestInTx(tx, { id, userId: actor.userId, classId });
      });
    } catch (e) {
      await this.mapEnrollmentDbError(e, actor.userId, classId);
    }
    const req = await this.repo.latestForUser(actor.userId);
    if (!req || req.classId !== classId) throw new ApiError(400, 'CLASS_NOT_AVAILABLE');
    return this.toEnrollmentDto(actor, req);
  }

  /** Demandes en attente de la classe (P8) : délégués de la classe et administrateurs. */
  async listRequests(actor: UserActor, classId: string): Promise<RequestDto[]> {
    this.authz.assert(actor, 'memberships.listRequests');
    if (!UUID.safeParse(classId).success) throw new ApiError(404, 'NOT_FOUND');
    return this.prisma.withTx(async (tx) => {
      if (!(await this.repo.lockClassInTx(tx, classId, false))) throw new ApiError(404, 'NOT_FOUND');
      await this.assertScopeInTx(tx, actor, classId);
      const rows = await this.repo.listPendingOfInTx(tx, classId);
      return rows.map((r) => ({ id: r.id, status: 'PENDING', createdAt: r.createdAt.toISOString(), user: { firstName: r.firstName, lastName: r.lastName, email: r.email } }));
    });
  }

  /** Membres actifs de la classe (P8, écran M9) : mêmes portées que les demandes. */
  async listMembers(actor: UserActor, classId: string): Promise<MemberDto[]> {
    this.authz.assert(actor, 'memberships.listMembers');
    if (!UUID.safeParse(classId).success) throw new ApiError(404, 'NOT_FOUND');
    return this.prisma.withTx(async (tx) => {
      if (!(await this.repo.lockClassInTx(tx, classId, false))) throw new ApiError(404, 'NOT_FOUND');
      await this.assertScopeInTx(tx, actor, classId);
      const rows = await this.repo.listMembersOfInTx(tx, classId);
      return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
    });
  }

  /**
   * Retrait d'un membre (§ 4.5, R6/R7) : le délégué retire un étudiant, l'admin n'importe qui ;
   * ressaisie du mot de passe datant de moins de 5 min (§ 3.3), clôture et audit dans la même transaction.
   * Le motif vit dans `class_memberships.left_note` — jamais dans l'audit (§ 2.5).
   */
  async remove(actor: UserActor, classId: string, userId: string, note: string | null): Promise<void> {
    this.authz.assert(actor, 'memberships.remove');
    if (!UUID.safeParse(classId).success || !UUID.safeParse(userId).success) throw new ApiError(404, 'NOT_FOUND');
    try {
      await this.prisma.withTx(async (tx) => {
        // Verrou d'écriture en tête (§ 2.1) : retrait sérialisé avec décisions, transferts et promotions.
        const cls = await this.repo.lockClassInTx(tx, classId, true);
        if (!cls) throw new ApiError(404, 'NOT_FOUND');
        await this.assertScopeInTx(tx, actor, classId);
        if (cls.status !== 'ACTIVE') throw new ApiError(409, 'CLASS_ARCHIVED');
        const role = await this.repo.roleInClassOfInTx(tx, userId, classId);
        if (!role) throw new ApiError(404, 'NOT_FOUND');
        if (actor.globalRole !== 'ADMIN' && role === 'DELEGATE') throw new ApiError(403, 'DELEGATE_FORBIDDEN');
        // Après la portée ET la cible : un étranger reçoit toujours le même 404, quoi qu'il en soit de son mot de passe.
        await this.freshness.assertRecentPasswordInTx(tx, actor);
        if (!(await this.repo.closeMembershipInTx(tx, { classId, userId, reason: 'REMOVED', leftBy: actor.userId, note }))) {
          throw new ApiError(404, 'NOT_FOUND'); // clôturée entre-temps : même corps qu'un absent
        }
        await this.audit.recordInTx(tx, actor, { action: 'MEMBER_REMOVED', targetType: 'USER', targetId: userId, metadata: { classId, userId } });
      });
    } catch (e) {
      throw this.decisionDbError(e);
    }
  }

  /** Nomination d'un délégué (M12) : administrateurs seulement, membre actif de la classe, ressaisie récente exigée. */
  async appointDelegate(actor: UserActor, classId: string, userId: string): Promise<DelegateDto> {
    this.authz.assert(actor, 'memberships.appointDelegate');
    if (!UUID.safeParse(classId).success || !UUID.safeParse(userId).success) throw new ApiError(404, 'NOT_FOUND');
    try {
      return await this.prisma.withTx(async (tx) => {
        const cls = await this.repo.lockClassInTx(tx, classId, true);
        if (!cls) throw new ApiError(404, 'NOT_FOUND');
        if (cls.status !== 'ACTIVE') throw new ApiError(409, 'CLASS_ARCHIVED');
        const role = await this.repo.roleInClassOfInTx(tx, userId, classId);
        if (!role) throw new ApiError(404, 'NOT_FOUND');
        await this.freshness.assertRecentPasswordInTx(tx, actor);
        if (role === 'STUDENT') {
          await this.repo.setRoleInTx(tx, { classId, userId, role: 'DELEGATE' });
          await this.audit.recordInTx(tx, actor, { action: 'DELEGATE_APPOINTED', targetType: 'USER', targetId: userId, metadata: { classId, userId } });
        }
        return { userId, role: 'DELEGATE' as const };
      });
    } catch (e) {
      throw this.delegateDbError(e);
    }
  }

  /** Révocation d'une délégation (M12) : idempotente ; sans effet ni audit si la personne n'est déjà plus déléguée. */
  async revokeDelegate(actor: UserActor, classId: string, userId: string): Promise<DelegateDto> {
    this.authz.assert(actor, 'memberships.revokeDelegate');
    if (!UUID.safeParse(classId).success || !UUID.safeParse(userId).success) throw new ApiError(404, 'NOT_FOUND');
    try {
      return await this.prisma.withTx(async (tx) => {
        const cls = await this.repo.lockClassInTx(tx, classId, true);
        if (!cls) throw new ApiError(404, 'NOT_FOUND');
        if (cls.status !== 'ACTIVE') throw new ApiError(409, 'CLASS_ARCHIVED');
        const role = await this.repo.roleInClassOfInTx(tx, userId, classId);
        if (!role) throw new ApiError(404, 'NOT_FOUND');
        await this.freshness.assertRecentPasswordInTx(tx, actor);
        if (role === 'DELEGATE') {
          await this.repo.setRoleInTx(tx, { classId, userId, role: 'STUDENT' });
          await this.audit.recordInTx(tx, actor, { action: 'DELEGATE_REVOKED', targetType: 'USER', targetId: userId, metadata: { classId, userId } });
        }
        return { userId, role: 'STUDENT' as const };
      });
    } catch (e) {
      throw this.delegateDbError(e);
    }
  }

  /**
   * Transfert simple (R7, M13) : administrateur seul, ressaisie du mot de passe datant de moins de
   * 5 min (§ 3.3). L'ancienne appartenance est clôturée `TRANSFER`, la nouvelle est créée étudiant —
   * un délégué transféré perd ses droits immédiatement (§ 0.3). Les deux classes sont verrouillées
   * dans l'ordre des identifiants, pour que deux transferts croisés ne se bloquent jamais (§ 2.1).
   */
  async transfer(actor: UserActor, userId: string, toClassId: string): Promise<TransferDto> {
    this.authz.assert(actor, 'memberships.transfer');
    if (!UUID.safeParse(userId).success) throw new ApiError(404, 'NOT_FOUND');
    try {
      await this.prisma.withTx(async (tx) => {
        // Sans appartenance active (inconnu, jamais accepté, clôturée entre-temps) : 404 identique.
        const from = await this.repo.activeMembershipOfInTx(tx, userId);
        if (!from) throw new ApiError(404, 'NOT_FOUND');
        const classes = await this.repo.lockClassesInTx(tx, [from.classId, toClassId]);
        const dest = classes.find((c) => c.id === toClassId);
        if (!dest) throw new ApiError(404, 'NOT_FOUND');
        if (dest.status !== 'ACTIVE') throw new ApiError(409, 'CLASS_ARCHIVED');
        // Après la portée ET la cible : un étranger reçoit le même 404, quoi qu'il en soit de son mot de passe.
        await this.freshness.assertRecentPasswordInTx(tx, actor);
        if (!(await this.repo.closeMembershipInTx(tx, { classId: from.classId, userId, reason: 'TRANSFER', leftBy: actor.userId, note: null }))) {
          throw new ApiError(404, 'NOT_FOUND'); // clôturée entre-temps : même corps qu'un absent
        }
        await this.repo.createMembershipInTx(tx, { userId, classId: toClassId });
        await this.audit.recordInTx(tx, actor, { action: 'MEMBER_TRANSFERRED', targetType: 'USER', targetId: userId, metadata: { userId, fromClassId: from.classId, toClassId } });
      });
    } catch (e) {
      throw this.transferDbError(e);
    }
    return { userId, toClassId };
  }

  /**
   * Transfert en masse (R7, M13) : la classe du trajet est la destination, le lot une liste d'étudiants.
   * Vérification supplémentaire complète (mot de passe puis code, § 3.3) et atomicité absolue : une
   * cible sans appartenance active annule tout. Les délégués ne sont pas reconduits (§ 0.3) — tout le
   * lot est reçu étudiant.
   */
  async transferMass(actor: UserActor, toClassId: string, userIds: string[]): Promise<TransferBatchDto> {
    this.authz.assert(actor, 'memberships.transferMass');
    if (!UUID.safeParse(toClassId).success) throw new ApiError(404, 'NOT_FOUND');
    if (userIds.length > MASS_TRANSFER_MAX) throw new ApiError(400, 'BATCH_TOO_LARGE'); // au-delà : plusieurs appels
    const targets = [...new Set(userIds)]; // un doublon dans le corps ne compte qu'une fois
    try {
      await this.prisma.withTx(async (tx) => {
        const froms = await this.repo.activeMembershipsOfInTx(tx, targets);
        // Chaque cible appartient à une autre classe : absente ou déjà membre de la destination → même 404.
        if (froms.length !== targets.length || froms.some((m) => m.classId === toClassId)) throw new ApiError(404, 'NOT_FOUND');
        const classes = await this.repo.lockClassesInTx(tx, [toClassId, ...froms.map((m) => m.classId)]);
        const dest = classes.find((c) => c.id === toClassId);
        if (!dest) throw new ApiError(404, 'NOT_FOUND');
        if (dest.status !== 'ACTIVE') throw new ApiError(409, 'CLASS_ARCHIVED');
        await this.freshness.assertStepUpFreshInTx(tx, actor);
        for (const m of froms) {
          if (!(await this.repo.closeMembershipInTx(tx, { classId: m.classId, userId: m.userId, reason: 'TRANSFER', leftBy: actor.userId, note: null }))) {
            throw new ApiError(404, 'NOT_FOUND'); // clôturée entre-temps : tout le lot est annulé
          }
          await this.repo.createMembershipInTx(tx, { userId: m.userId, classId: toClassId });
          await this.audit.recordInTx(tx, actor, { action: 'MEMBER_TRANSFERRED', targetType: 'USER', targetId: m.userId, metadata: { userId: m.userId, fromClassId: m.classId, toClassId } });
        }
      });
    } catch (e) {
      throw this.transferDbError(e);
    }
    return { transferred: targets.length };
  }

  /** Les déclencheurs d'appartenance portent la règle (§ 0.2) : leur message devient un code d'API. */
  private transferDbError(e: unknown): unknown {
    const msg = dbMessageOf(e);
    if (msg.includes('membership: class is not active')) return new ApiError(409, 'CLASS_ARCHIVED'); // course retranchée
    if (msg.includes('membership: user cannot join')) return new ApiError(403, 'FORBIDDEN'); // compte suspendu ou rôle non étudiant
    // Appartenance prise ailleurs entre-temps (index membership_one_active) : même 404 qu'un absent.
    if (isUniqueViolation(e)) return new ApiError(404, 'NOT_FOUND');
    return e;
  }

  /** Le déclencheur membership_delegate_limit porte la limite (§ 0.2, R8) : son message devient un code d'API. */
  private delegateDbError(e: unknown): unknown {
    const msg = dbMessageOf(e);
    if (msg.includes('delegate limit reached')) return new ApiError(409, 'DELEGATE_LIMIT_REACHED');
    return this.decisionDbError(e);
  }

  /** Acceptation : appartenance étudiante en même temps que la décision, dans une transaction unique (§ 0.3). */
  async accept(actor: UserActor, classId: string, requestId: string): Promise<AcceptDecisionDto> {
    this.authz.assert(actor, 'memberships.accept');
    if (!UUID.safeParse(classId).success || !UUID.safeParse(requestId).success) throw new ApiError(404, 'NOT_FOUND');
    try {
      return await this.prisma.withTx(async (tx) => {
        // Verrou d'écriture en tête (§ 2.1) : décisions, demandes et appartenance sérialisées.
        const cls = await this.repo.lockClassInTx(tx, classId, true);
        if (!cls) throw new ApiError(404, 'NOT_FOUND');
        if (cls.status !== 'ACTIVE') throw new ApiError(409, 'CLASS_ARCHIVED');
        await this.assertScopeInTx(tx, actor, classId);
        const req = await this.repo.requestOfInTx(tx, classId, requestId);
        if (!req) throw new ApiError(404, 'NOT_FOUND');
        if (req.status !== 'PENDING') throw new ApiError(409, 'REQUEST_ALREADY_DECIDED');
        const decided = await this.repo.decideInTx(tx, { requestId, classId, status: 'ACCEPTED', decidedBy: actor.userId, note: null });
        if (!decided) throw new ApiError(409, 'REQUEST_ALREADY_DECIDED'); // concurrence : le `and status = 'PENDING'` a tranché
        const membership = await this.repo.createMembershipInTx(tx, { userId: req.userId, classId });
        await this.audit.recordInTx(tx, actor, { action: 'ENROLLMENT_ACCEPTED', targetType: 'ENROLLMENT_REQUEST', targetId: requestId, metadata: { classId, userId: req.userId } });
        return {
          status: 'ACCEPTED' as const,
          decidedAt: decided.decidedAt.toISOString(),
          membership: { classId, role: 'STUDENT' as const, joinedAt: membership.joinedAt.toISOString() },
        };
      });
    } catch (e) {
      throw this.decisionDbError(e);
    }
  }

  /** Refus : motif facultatif transmis à l'étudiante par email (R6) ; définitif (déclencheur enrollment_decision_final). */
  async refuse(actor: UserActor, classId: string, requestId: string, note: string | null): Promise<void> {
    this.authz.assert(actor, 'memberships.refuse');
    if (!UUID.safeParse(classId).success || !UUID.safeParse(requestId).success) throw new ApiError(404, 'NOT_FOUND');
    try {
      await this.prisma.withTx(async (tx) => {
        const cls = await this.repo.lockClassInTx(tx, classId, true);
        if (!cls) throw new ApiError(404, 'NOT_FOUND');
        if (cls.status !== 'ACTIVE') throw new ApiError(409, 'CLASS_ARCHIVED');
        await this.assertScopeInTx(tx, actor, classId);
        const req = await this.repo.requestOfInTx(tx, classId, requestId);
        if (!req) throw new ApiError(404, 'NOT_FOUND');
        if (req.status !== 'PENDING') throw new ApiError(409, 'REQUEST_ALREADY_DECIDED');
        const decided = await this.repo.decideInTx(tx, { requestId, classId, status: 'REFUSED', decidedBy: actor.userId, note });
        if (!decided) throw new ApiError(409, 'REQUEST_ALREADY_DECIDED');
        await this.audit.recordInTx(tx, actor, { action: 'ENROLLMENT_REFUSED', targetType: 'ENROLLMENT_REQUEST', targetId: requestId, metadata: { classId, userId: req.userId } });
        // Clé anti-doublon par demande : un refus part au plus une fois, même en cas de rejeu.
        await this.mail.enqueueInTx(tx, actor, {
          kind: 'REFUSAL',
          recipientUserId: req.userId,
          toAddress: req.email,
          dedupeKey: `enrollment-refusal:${requestId}`,
          payload: { className: cls.name, ...(note ? { note } : {}) },
          expiresInSeconds: REFUSAL_EMAIL_TTL_S,
        });
      });
    } catch (e) {
      throw this.decisionDbError(e);
    }
  }

  /** Portée de classe (R2) : admin ; sinon délégué actif ; étudiant → 403 ; hors classe → 404 identique à l'inexistant. */
  private async assertScopeInTx(tx: TxClient, actor: UserActor, classId: string): Promise<void> {
    if (actor.globalRole === 'ADMIN') return;
    const role = await this.repo.roleInClassOfInTx(tx, actor.userId, classId);
    if (!role) throw new ApiError(404, 'NOT_FOUND');
    if (role !== 'DELEGATE') throw new ApiError(403, 'FORBIDDEN');
  }

  /** Les déclencheurs d'inscription portent la règle (§ 0.3) : leur message devient un code d'API. */
  private async mapEnrollmentDbError(e: unknown, userId: string, classId: string): Promise<never> {
    const msg = dbMessageOf(e);
    if (msg.includes('refused less than 24 hours')) {
      const last = await this.repo.lastRefusalAt(userId, classId);
      const at = (last?.getTime() ?? Date.now()) + REFUSAL_RETRY_MS;
      throw new ApiError(400, 'ENROLLMENT_RETRY_PENDING', { retryAfter: new Date(at).toISOString() });
    }
    if (msg.includes('already a member')) throw new ApiError(409, 'ALREADY_MEMBER');
    if (msg.includes('enrollment_one_pending')) throw new ApiError(409, 'REQUEST_ALREADY_PENDING');
    if (msg.includes('user cannot enroll')) throw new ApiError(403, 'FORBIDDEN');
    if (msg.includes('class is not active')) throw new ApiError(400, 'CLASS_NOT_AVAILABLE');
    throw e;
  }

  /** Arrière-plans des déclencheurs de décision, hors des vérifications de service (concurrence, suspension). */
  private decisionDbError(e: unknown): unknown {
    const msg = dbMessageOf(e);
    if (msg.includes('decision is final')) return new ApiError(409, 'REQUEST_ALREADY_DECIDED');
    if (msg.includes('class is not active')) return new ApiError(409, 'CLASS_ARCHIVED');
    if (msg.includes('user cannot join')) return new ApiError(403, 'FORBIDDEN');
    return e;
  }

  /** Vue demande du compte (MeService, écrans d'état § 1.1) ; le retryAfter ne vaut que pour un refus. */
  async toEnrollmentDto(actor: UserActor, req: EnrollmentRow): Promise<EnrollmentDto> {
    return {
      id: req.id,
      status: req.status,
      class: await this.classes.summaryOf(actor, req.classId),
      createdAt: req.createdAt.toISOString(),
      decidedAt: req.decidedAt?.toISOString() ?? null,
      decisionNote: req.decisionNote,
      retryAfter: req.status === 'REFUSED' && req.decidedAt ? new Date(req.decidedAt.getTime() + REFUSAL_RETRY_MS).toISOString() : null,
    };
  }
}
