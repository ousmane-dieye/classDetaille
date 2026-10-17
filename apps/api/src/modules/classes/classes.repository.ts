import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import type { ClassSummaryDto, SubjectRow } from './class.dto.js';

const SUMMARY = { id: true, name: true, level: true, academicYear: true } as const;

type ClassStatusRow = { status: 'ACTIVE' | 'ARCHIVED' };

@Injectable()
export class ClassesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  listActive(): Promise<ClassSummaryDto[]> {
    return this.prisma.client.class.findMany({ where: { status: 'ACTIVE' }, select: SUMMARY, orderBy: [{ academicYear: 'desc' }, { name: 'asc' }] });
  }

  findSummary(id: string): Promise<ClassSummaryDto | null> {
    return this.prisma.client.class.findUnique({ where: { id }, select: SUMMARY });
  }

  /** Verrou partagé de l'ordre global (classes avant users) ; vrai si la classe existe et est active. */
  async lockActiveForShareInTx(tx: TxClient, id: string): Promise<boolean> {
    const r = await tx.$queryRaw<{ active: boolean }[]>`select status = 'ACTIVE' as active from app.classes where id = ${id}::uuid for share`;
    return r[0]?.active === true;
  }

  async createInTx(tx: TxClient, row: { id: string } & Omit<ClassSummaryDto, 'id'>): Promise<void> {
    // SQL brut : cp_app n'a que des droits par colonne, et `create` envoie aussi des colonnes non accordées (status…).
    await tx.$executeRaw`insert into app.classes (id, name, level, academic_year) values (${row.id}::uuid, ${row.name}, ${row.level}, ${row.academicYear})`;
  }

  /**
   * Verrou de l'ordre global (§ 2.1) sur `classes`, en tête de transaction de toute écriture de la classe.
   * `forUpdate` : `for no key update`, pour sérialiser les écritures concurrentes.
   */
  async lockClassInTx(tx: TxClient, classId: string, forUpdate: boolean): Promise<ClassStatusRow | null> {
    const rows = forUpdate
      ? await tx.$queryRaw<ClassStatusRow[]>`select status from app.classes where id = ${classId}::uuid for no key update`
      : await tx.$queryRaw<ClassStatusRow[]>`select status from app.classes where id = ${classId}::uuid for share`;
    return rows[0] ?? null;
  }

  /**
   * Appartenance active de l'acteur dans la classe, pour la portée « délégué » (R2).
   * Même lecture que `MembershipsRepository.roleInClassOfInTx` — dupliquée pour éviter un cycle
   * de modules (MembershipsModule importe ClassModules) ; la règle d'interdiction reste en base.
   */
  async roleInClassOfInTx(tx: TxClient, userId: string, classId: string): Promise<'STUDENT' | 'DELEGATE' | null> {
    const rows = await tx.$queryRaw<{ role: 'STUDENT' | 'DELEGATE' }[]>`select role from app.class_memberships where user_id = ${userId}::uuid and class_id = ${classId}::uuid and left_at is null for share`;
    return rows[0]?.role ?? null;
  }

  /** Matières de la classe (R12) : lecture seule, triées par nom. */
  listSubjectsOfInTx(tx: TxClient, classId: string): Promise<SubjectRow[]> {
    return tx.$queryRaw<SubjectRow[]>`select id, name, created_at as "createdAt" from app.subjects where class_id = ${classId}::uuid order by name, id`;
  }

  /** Matière de la classe par son identifiant ; `null` si absente ou si elle appartient à une autre classe. */
  async findSubjectInTx(tx: TxClient, classId: string, subjectId: string): Promise<SubjectRow | null> {
    const rows = await tx.$queryRaw<SubjectRow[]>`select id, name, created_at as "createdAt" from app.subjects where class_id = ${classId}::uuid and id = ${subjectId}::uuid`;
    return rows[0] ?? null;
  }

  /** Création (R12) : colonnes seules, jamais le `class_id` en dehors du verrou de la classe. */
  async createSubjectInTx(tx: TxClient, row: { id: string; classId: string; name: string }): Promise<SubjectRow> {
    const rows = await tx.$queryRaw<SubjectRow[]>`insert into app.subjects (id, class_id, name) values (${row.id}::uuid, ${row.classId}::uuid, ${row.name}) returning id, name, created_at as "createdAt"`;
    const r = rows[0];
    if (!r) throw new Error('subject insert returned no row');
    return r;
  }

  /** Suppression d'une matière (R12) : la base refuse si elle est référencée (déclencheur du lot 3). */
  async deleteSubjectInTx(tx: TxClient, classId: string, subjectId: string): Promise<boolean> {
    const n = await tx.$executeRaw`delete from app.subjects where class_id = ${classId}::uuid and id = ${subjectId}::uuid`;
    return n === 1;
  }
}
