import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import type { LoginUser, NewStudent, UserProfileDto } from './user.dto.js';

const PROFILE = { id: true, email: true, firstName: true, lastName: true, globalRole: true, emailReminders: true, emailAnnouncements: true } as const;
const LOGIN = { id: true, email: true, passwordHash: true, globalRole: true, status: true } as const;

@Injectable()
export class UsersRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<LoginUser | null> {
    const u = await this.prisma.client.user.findUnique({ where: { email }, select: LOGIN });
    return u?.email ? { ...u, email: u.email } : null;
  }

  async findLoginById(id: string): Promise<LoginUser | null> {
    const u = await this.prisma.client.user.findUnique({ where: { id }, select: LOGIN });
    return u?.email ? { ...u, email: u.email } : null;
  }

  async activeRoleOf(id: string): Promise<'USER' | 'ADMIN' | null> {
    const u = await this.prisma.client.user.findFirst({ where: { id, status: 'ACTIVE' }, select: { globalRole: true } });
    return u?.globalRole ?? null;
  }

  /** État d'authentification : rôle si ACTIVE, sinon motif de révocation (SUSPENDED → SUSPENDED, DELETED → ANONYMIZED). */
  async authStateOf(id: string): Promise<{ role: 'USER' | 'ADMIN' } | { revokeReason: 'SUSPENDED' | 'ANONYMIZED' } | null> {
    const u = await this.prisma.client.user.findFirst({ where: { id }, select: { globalRole: true, status: true } });
    if (!u) return null;
    if (u.status === 'ACTIVE') return { role: u.globalRole };
    return { revokeReason: u.status === 'SUSPENDED' ? 'SUSPENDED' : 'ANONYMIZED' };
  }

  async findProfile(id: string): Promise<UserProfileDto | null> {
    const u = await this.prisma.client.user.findFirst({ where: { id, status: 'ACTIVE' }, select: PROFILE });
    if (!u?.email || !u.firstName || !u.lastName) return null;
    return { ...u, email: u.email, firstName: u.firstName, lastName: u.lastName };
  }

  async createInTx(tx: TxClient, row: NewStudent & { globalRole: 'USER' | 'ADMIN' }): Promise<void> {
    // SQL paramétré sur les colonnes accordées à cp_app : `create` de Prisma envoie aussi des valeurs par défaut (42501).
    await tx.$executeRaw`
      insert into app.users (id, email, first_name, last_name, password_hash, global_role, status, created_at, updated_at)
      values (${row.id}::uuid, ${row.email}::ext.citext, ${row.firstName}, ${row.lastName}, ${row.passwordHash},
              ${row.globalRole}::app.global_role, 'ACTIVE'::app.user_status, now(), now())`;
  }

  async updateProfile(id: string, firstName: string, lastName: string): Promise<void> {
    await this.prisma.client.user.update({ where: { id }, data: { firstName, lastName, updatedAt: new Date() }, select: { id: true } });
  }

  async updatePreferences(id: string, prefs: { emailReminders?: boolean; emailAnnouncements?: boolean }): Promise<void> {
    await this.prisma.client.user.update({ where: { id }, data: { ...prefs, updatedAt: new Date() }, select: { id: true } });
  }

  async setPasswordHashInTx(tx: TxClient, id: string, passwordHash: string): Promise<void> {
    await tx.user.update({ where: { id }, data: { passwordHash, updatedAt: new Date() }, select: { id: true } });
  }

  /** Premier verrou de l'ordre global (§ 2.1). */
  async lockRoleGuardInTx(tx: TxClient): Promise<void> {
    await tx.$queryRaw`select id from app.role_guard where id = 1 for update`;
  }

  async activeAdminExistsInTx(tx: TxClient): Promise<boolean> {
    const r = await tx.$queryRaw<{ found: boolean }[]>`select exists (select 1 from app.users where global_role = 'ADMIN' and status = 'ACTIVE') as found`;
    return r[0]?.found === true;
  }
}
