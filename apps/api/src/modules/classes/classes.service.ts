import { Inject, Injectable } from '@nestjs/common';
import { hasForbiddenNameChars, isValidName, normalizeName } from '@classepulse/shared';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { isUniqueViolation } from '../../database/errors.js';
import { ApiError } from '../../http/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { Actor, AnonymousActor, CliActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import type { ClassSummaryDto } from './class.dto.js';
import { ClassesRepository } from './classes.repository.js';

const YEAR = /^(\d{4})-(\d{4})$/;

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
}
