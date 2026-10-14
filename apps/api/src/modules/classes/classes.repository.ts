import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import type { ClassSummaryDto } from './class.dto.js';

const SUMMARY = { id: true, name: true, level: true, academicYear: true } as const;

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
}
