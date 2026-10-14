import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import type { EnrollmentRow } from './enrollment.dto.js';

@Injectable()
export class MembershipsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createRequestInTx(tx: TxClient, row: { id: string; userId: string; classId: string }): Promise<void> {
    // Le trigger enrollment_request_valid vérifie la classe, l'utilisateur et le délai après refus (R9).
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
}
