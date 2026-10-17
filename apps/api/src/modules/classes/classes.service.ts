import { Inject, Injectable } from '@nestjs/common';
import { hasForbiddenNameChars, isValidName, isValidSubjectName, normalizeName } from '@classepulse/shared';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { dbMessageOf, isUniqueViolation } from '../../database/errors.js';
import { ApiError } from '../../http/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { Actor, AnonymousActor, CliActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import type { ClassSummaryDto, SubjectDto } from './class.dto.js';
import { ClassesRepository } from './classes.repository.js';

const YEAR = /^(\d{4})-(\d{4})$/;
const UUID = z.uuid();

@Injectable()
export class ClassesService {
  constructor(
    @Inject(ClassesRepository) private readonly repo: ClassesRepository,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async listActive(actor: Actor): Promise<ClassSummaryDto[]> {
    this.authz.assert(actor, 'classes.listActive');
    return this.repo.listActive();
  }

  async lockActiveForEnrollmentInTx(tx: TxClient, actor: AnonymousActor, classId: string): Promise<void> {
    this.authz.assert(actor, 'auth.register');
    if (!(await this.repo.lockActiveForShareInTx(tx, classId))) throw new ApiError(400, 'CLASS_NOT_AVAILABLE');
  }

  /** Résumé de la classe d'une demande de l'acteur (écran d'état) ; la vérification d'appartenance arrive au lot 2. */
  async summaryOf(actor: UserActor, classId: string): Promise<ClassSummaryDto | null> {
    this.authz.assert(actor, 'me.read');
    return this.repo.findSummary(classId);
  }

  /** `create-class` (R8). */
  async create(actor: CliActor, input: { name: string; level: string; academicYear: string }): Promise<string> {
    this.authz.assert(actor, 'classes.create');
    const name = normalizeName(input.name);
    const level = normalizeName(input.level);
    const m = YEAR.exec(input.academicYear.trim());
    if (!isValidName(name)) throw new ApiError(400, 'INVALID_CLASS_NAME');
    if ([...level].length < 1 || [...level].length > 40 || hasForbiddenNameChars(level)) throw new ApiError(400, 'INVALID_CLASS_LEVEL');
    if (!m || Number(m[2]) !== Number(m[1]) + 1) throw new ApiError(400, 'INVALID_ACADEMIC_YEAR');
    const id = uuidv7();
    try {
      await this.prisma.withTx(async (tx) => {
        await this.repo.createInTx(tx, { id, name, level, academicYear: input.academicYear.trim() });
        await this.audit.recordInTx(tx, actor, { action: 'CLASS_CREATED', targetType: 'CLASS', targetId: id, metadata: { via: 'cli' } });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'CLASS_ALREADY_EXISTS');
      throw e;
    }
    return id;
  }

  /** Matières de la classe (R12, écran M9) : délégué de la classe ou administrateur (R2). */
  async listSubjects(actor: UserActor, classId: string): Promise<SubjectDto[]> {
    this.authz.assert(actor, 'classes.listSubjects');
    if (!UUID.safeParse(classId).success) throw new ApiError(404, 'NOT_FOUND');
    return this.prisma.withTx(async (tx) => {
      if (!(await this.repo.lockClassInTx(tx, classId, false))) throw new ApiError(404, 'NOT_FOUND');
      await this.assertDelegateOrAdminInTx(tx, actor, classId);
      const rows = await this.repo.listSubjectsOfInTx(tx, classId);
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    });
  }

  /** Création d'une matière (R12) : nom NFC normalisé, 2–60 points de code, sans caractère Cc/Cf ; l'unicité est en base. */
  async createSubject(actor: UserActor, classId: string, rawName: string): Promise<SubjectDto> {
    this.authz.assert(actor, 'classes.createSubject');
    if (!UUID.safeParse(classId).success) throw new ApiError(404, 'NOT_FOUND');
    const name = normalizeName(rawName);
    if (!isValidSubjectName(name)) throw new ApiError(400, 'INVALID_SUBJECT_NAME');
    try {
      return await this.prisma.withTx(async (tx) => {
        const cls = await this.repo.lockClassInTx(tx, classId, true);
        if (!cls) throw new ApiError(404, 'NOT_FOUND');
        if (cls.status !== 'ACTIVE') throw new ApiError(409, 'CLASS_ARCHIVED');
        await this.assertDelegateOrAdminInTx(tx, actor, classId);
        const id = uuidv7();
        const r = await this.repo.createSubjectInTx(tx, { id, classId, name });
        await this.audit.recordInTx(tx, actor, { action: 'SUBJECT_CREATED', targetType: 'SUBJECT', targetId: id, metadata: { classId, subjectId: id, name } });
        return { ...r, createdAt: r.createdAt.toISOString() };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'SUBJECT_ALREADY_EXISTS'); // index subjects_one_name_per_class
      if (dbMessageOf(e).includes('subjects_name_len')) throw new ApiError(400, 'INVALID_SUBJECT_NAME'); // borne de la base
      if (dbMessageOf(e).includes('subjects: class is not active')) throw new ApiError(409, 'CLASS_ARCHIVED'); // déclencheur, course retranchée
      throw e;
    }
  }

  /** Suppression d'une matière (R12) : la base refuse si elle est référencée ; aucune écriture dans une classe archivée. */
  async deleteSubject(actor: UserActor, classId: string, subjectId: string): Promise<void> {
    this.authz.assert(actor, 'classes.deleteSubject');
    if (!UUID.safeParse(classId).success || !UUID.safeParse(subjectId).success) throw new ApiError(404, 'NOT_FOUND');
    await this.prisma.withTx(async (tx) => {
      const cls = await this.repo.lockClassInTx(tx, classId, true);
      if (!cls) throw new ApiError(404, 'NOT_FOUND');
      if (cls.status !== 'ACTIVE') throw new ApiError(409, 'CLASS_ARCHIVED');
      await this.assertDelegateOrAdminInTx(tx, actor, classId);
      const s = await this.repo.findSubjectInTx(tx, classId, subjectId);
      if (!s) throw new ApiError(404, 'NOT_FOUND');
      await this.repo.deleteSubjectInTx(tx, classId, subjectId);
      await this.audit.recordInTx(tx, actor, { action: 'SUBJECT_DELETED', targetType: 'SUBJECT', targetId: subjectId, metadata: { classId, subjectId, name: s.name } });
    });
  }

  /** Portée « délégué » (R2) : l'administrateur passe toujours ; sinon délégué actif de la classe. */
  private async assertDelegateOrAdminInTx(tx: TxClient, actor: UserActor, classId: string): Promise<void> {
    if (actor.globalRole === 'ADMIN') return;
    if ((await this.repo.roleInClassOfInTx(tx, actor.userId, classId)) !== 'DELEGATE') throw new ApiError(403, 'FORBIDDEN');
  }
}
