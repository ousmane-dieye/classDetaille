import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import type { EnrollmentRow, RequestRow } from './enrollment.dto.js';
import type { MemberRow } from './member.dto.js';

/** Motif de clôture — miroir TS de app.leave_reason (§ 0.3 : REMOVED, TRANSFER, …). */
export type LeaveReason = 'REMOVED' | 'TRANSFER' | 'CLASS_ARCHIVED' | 'ACCOUNT_DELETED';

@Injectable()
export class MembershipsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createRequestInTx(tx: TxClient, row: { id: string; userId: string; classId: string }): Promise<void> {
    // Le trigger enrollment_request_valid vérifie la classe, l'utilisateur, l'appartenance et le délai après refus (R9, § 0.3).
    // SQL brut : droits par colonne pour cp_app (voir ClassesRepository.createInTx).
    await tx.$executeRaw`insert into app.enrollment_requests (id, user_id, class_id) values (${row.id}::uuid, ${row.userId}::uuid, ${row.classId}::uuid)`;
  }

  latestForUser(userId: string): Promise<EnrollmentRow | null> {
    return this.prisma.client.enrollmentRequest.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, classId: true, createdAt: true, decidedAt: true, decisionNote: true },
    });
  }

  /** Dernière date de refus, pour le retryAfter du délai de 24 h (§ 0.3). */
  async lastRefusalAt(userId: string, classId: string): Promise<Date | null> {
    const row = await this.prisma.client.enrollmentRequest.findFirst({
      where: { userId, classId, status: 'REFUSED' },
      orderBy: { decidedAt: 'desc' },
      select: { decidedAt: true },
    });
    return row?.decidedAt ?? null;
  }

  /**
   * Verrou de l'ordre global (§ 2.1 : classes → users → class_memberships → enrollment_requests).
   * Décisions : `for no key update` en tête de transaction, pour sérialiser avec les demandes (`for share`).
   */
  async lockClassInTx(tx: TxClient, classId: string, forDecision: boolean): Promise<{ name: string; status: string } | null> {
    const rows = forDecision
      ? await tx.$queryRaw<{ name: string; status: string }[]>`select name, status from app.classes where id = ${classId}::uuid for no key update`
      : await tx.$queryRaw<{ name: string; status: string }[]>`select name, status from app.classes where id = ${classId}::uuid for share`;
    return rows[0] ?? null;
  }

  /** Appartenance active de l'acteur dans la classe, pour la portée « délégué » (R2). */
  async roleInClassOfInTx(tx: TxClient, userId: string, classId: string): Promise<'STUDENT' | 'DELEGATE' | null> {
    const rows = await tx.$queryRaw<{ role: 'STUDENT' | 'DELEGATE' }[]>`select role from app.class_memberships where user_id = ${userId}::uuid and class_id = ${classId}::uuid and left_at is null for share`;
    return rows[0]?.role ?? null;
  }

  /** Appartenance active unique de la personne, pour le transfert (R7) : `null` si elle n'appartient à aucune classe. */
  async activeMembershipOfInTx(tx: TxClient, userId: string): Promise<{ classId: string; role: 'STUDENT' | 'DELEGATE' } | null> {
    const rows = await tx.$queryRaw<{ classId: string; role: 'STUDENT' | 'DELEGATE' }[]>`select class_id as "classId", role from app.class_memberships where user_id = ${userId}::uuid and left_at is null`;
    return rows[0] ?? null;
  }

  /** Appartenances actives d'un lot (R7) : lecture unique pour le transfert en masse (atomique, tout ou rien). */
  async activeMembershipsOfInTx(tx: TxClient, userIds: string[]): Promise<Array<{ userId: string; classId: string }>> {
    return tx.$queryRaw<Array<{ userId: string; classId: string }>>`select user_id as "userId", class_id as "classId"
      from app.class_memberships where left_at is null and user_id = any(${userIds}::uuid[])`;
  }

  /**
   * Verrous de plusieurs classes (R7, transferts) : `for no key update` un par un, **dans l'ordre des
   * identifiants**, pour que deux transferts croisés ne se bloquent jamais (ordre global § 2.1).
   */
  async lockClassesInTx(tx: TxClient, classIds: string[]): Promise<Array<{ id: string; status: string }>> {
    const rows: Array<{ id: string; status: string }> = [];
    for (const id of [...new Set(classIds)].sort()) {
      const r = await tx.$queryRaw<{ id: string; status: string }[]>`select id, status from app.classes where id = ${id}::uuid for no key update`;
      const row = r[0];
      if (row) rows.push(row);
    }
    return rows;
  }

  /** Demandes en attente de la classe, avec l'email (P8) : lecture seule, sans relation Prisma (maison : SQL). */
  listPendingOfInTx(tx: TxClient, classId: string): Promise<RequestRow[]> {
    return tx.$queryRaw<RequestRow[]>`select r.id as "id", r.status as "status", r.created_at as "createdAt", u.first_name as "firstName", u.last_name as "lastName", u.email as "email"
      from app.enrollment_requests r join app.users u on u.id = r.user_id
      where r.class_id = ${classId}::uuid and r.status = 'PENDING' order by r.created_at, r.id`;
  }

  /** Demande de la classe : id, statut, étudiante et email (rejet de portée : inconnue de cette classe). */
  async requestOfInTx(tx: TxClient, classId: string, requestId: string): Promise<{ id: string; status: string; userId: string; email: string } | null> {
    const rows = await tx.$queryRaw<{ id: string; status: string; userId: string; email: string }[]>`select r.id as "id", r.status as "status", r.user_id as "userId", u.email
      from app.enrollment_requests r join app.users u on u.id = r.user_id
      where r.id = ${requestId}::uuid and r.class_id = ${classId}::uuid`;
    return rows[0] ?? null;
  }

  /** Décision : `and status = 'PENDING'` rend la tranchée unique (le déclencheur enrollment_decision_final double la protection). */
  async decideInTx(
    tx: TxClient,
    row: { requestId: string; classId: string; status: 'ACCEPTED' | 'REFUSED'; decidedBy: string; note: string | null },
  ): Promise<{ decidedAt: Date } | null> {
    const rows = await tx.$queryRaw<{ decidedAt: Date }[]>`update app.enrollment_requests
      set status = ${row.status}::app.enrollment_status, decided_at = clock_timestamp(), decided_by = ${row.decidedBy}::uuid, decision_note = ${row.note}
      where id = ${row.requestId}::uuid and class_id = ${row.classId}::uuid and status = 'PENDING'
      returning decided_at as "decidedAt"`;
    return rows[0] ?? null;
  }

  /** Appartenance créée par l'acceptation (rôle étudiant ; la délégation est une action distincte, tâche 4). */
  async createMembershipInTx(tx: TxClient, row: { userId: string; classId: string }): Promise<{ joinedAt: Date }> {
    const rows = await tx.$queryRaw<{ joinedAt: Date }[]>`insert into app.class_memberships (id, user_id, class_id, role) values (${uuidv7()}::uuid, ${row.userId}::uuid, ${row.classId}::uuid, 'STUDENT') returning joined_at as "joinedAt"`;
    const r = rows[0];
    if (!r) throw new Error('membership insert returned no row');
    return r;
  }

  /** Membres actifs de la classe (P8) : tri stable par nom. */
  listMembersOfInTx(tx: TxClient, classId: string): Promise<MemberRow[]> {
    return tx.$queryRaw<MemberRow[]>`select m.user_id as "userId", u.first_name as "firstName", u.last_name as "lastName", u.email as "email", m.role as "role", m.joined_at as "joinedAt"
      from app.class_memberships m join app.users u on u.id = m.user_id
      where m.class_id = ${classId}::uuid and m.left_at is null
      order by u.last_name, u.first_name, m.user_id`;
  }

  /**
   * Clôture d'une appartenance (§ 4.5) : date, motif et acteur ensemble (contrainte membership_departure ;
   * la note 1–500, même borne que le schéma HTTP). `false` : déjà clôturée entre-temps.
   */
  async closeMembershipInTx(
    tx: TxClient,
    row: { classId: string; userId: string; reason: LeaveReason; leftBy: string; note: string | null },
  ): Promise<boolean> {
    const n = await tx.$executeRaw`update app.class_memberships
      set left_at = clock_timestamp(), left_reason = ${row.reason}::app.leave_reason, left_by = ${row.leftBy}::uuid, left_note = ${row.note}, updated_at = clock_timestamp()
      where class_id = ${row.classId}::uuid and user_id = ${row.userId}::uuid and left_at is null`;
    return n === 1;
  }

  /**
   * Changement de rôle (M12) : le déclencheur membership_delegate_limit fait foi pour la limite
   * de deux délégués (§ 0.2, R8) ; le service ne traduit que son message.
   */
  async setRoleInTx(tx: TxClient, row: { classId: string; userId: string; role: 'STUDENT' | 'DELEGATE' }): Promise<void> {
    await tx.$executeRaw`update app.class_memberships
      set role = ${row.role}::app.class_role, updated_at = clock_timestamp()
      where class_id = ${row.classId}::uuid and user_id = ${row.userId}::uuid and left_at is null`;
  }
}
