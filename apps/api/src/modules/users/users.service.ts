import { Inject, Injectable } from '@nestjs/common';
import { isAcceptedEmail, normalizeEmail, normalizeName, type UpdatePreferencesBody, type UpdateProfileBody } from '@classepulse/shared';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { AnonymousActor, CliActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { CommonPasswords } from './common-passwords.js';
import { PasswordHasher } from './password-hasher.js';
import { validateNewPassword } from './password-policy.js';
import type { LoginUser, NewAdminInput, NewStudent, UserProfileDto } from './user.dto.js';
import { UsersRepository } from './users.repository.js';

const nameOk = (n: string) => [...n].length >= 2 && [...n].length <= 80;

@Injectable()
export class UsersService {
  constructor(
    @Inject(UsersRepository) private readonly repo: UsersRepository,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(CommonPasswords) private readonly common: CommonPasswords,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** `email` : forme normalisée (les schémas Zod l'ont déjà normalisé). */
  async findForLogin(actor: AnonymousActor, email: string): Promise<LoginUser | null> {
    this.authz.assert(actor, 'auth.login');
    return this.repo.findByEmail(email);
  }

  async credentialsOf(actor: UserActor): Promise<LoginUser> {
    this.authz.assert(actor, 'me.changePassword');
    const u = await this.repo.findLoginById(actor.userId);
    if (!u) throw new ApiError(401, 'UNAUTHENTICATED');
    return u;
  }

  async createStudentInTx(tx: TxClient, actor: AnonymousActor, input: NewStudent): Promise<void> {
    this.authz.assert(actor, 'auth.register');
    await this.repo.createInTx(tx, { ...input, globalRole: 'USER' });
  }

  /** `create-admin` (§ 3.2) : refusé s'il existe déjà un administrateur actif ; sérialisé par role_guard. */
  async createFirstAdmin(actor: CliActor, input: NewAdminInput): Promise<string> {
    this.authz.assert(actor, 'admin.createFirst');
    const email = normalizeEmail(input.email);
    if (!isAcceptedEmail(email)) throw new ApiError(400, 'INVALID_EMAIL');
    const firstName = normalizeName(input.firstName);
    const lastName = normalizeName(input.lastName);
    if (!nameOk(firstName) || !nameOk(lastName)) throw new ApiError(400, 'INVALID_NAME');
    const pw = validateNewPassword(input.password, 'ADMIN', this.common);
    if (!pw.ok) throw new ApiError(400, pw.code);
    const passwordHash = await this.hasher.hash(pw.normalized);
    const id = uuidv7();
    await this.prisma.withTx(async (tx) => {
      await this.repo.lockRoleGuardInTx(tx);
      if (await this.repo.activeAdminExistsInTx(tx)) throw new ApiError(409, 'ADMIN_ALREADY_EXISTS');
      await this.repo.createInTx(tx, { id, email, firstName, lastName, passwordHash, globalRole: 'ADMIN' });
      await this.audit.recordInTx(tx, actor, { action: 'ADMIN_CREATED', targetType: 'USER', targetId: id, metadata: { via: 'cli' } });
    });
    return id;
  }

  async setPasswordHashInTx(tx: TxClient, actor: UserActor, passwordHash: string): Promise<void> {
    this.authz.assert(actor, 'me.changePassword');
    await this.repo.setPasswordHashInTx(tx, actor.userId, passwordHash);
  }

  async profileOf(actor: UserActor): Promise<UserProfileDto> {
    this.authz.assert(actor, 'me.read');
    const p = await this.repo.findProfile(actor.userId);
    if (!p) throw new ApiError(401, 'UNAUTHENTICATED');
    return p;
  }

  async updateProfile(actor: UserActor, body: UpdateProfileBody): Promise<void> {
    this.authz.assert(actor, 'me.updateProfile');
    await this.repo.updateProfile(actor.userId, body.firstName, body.lastName);
  }

  async updatePreferences(actor: UserActor, body: UpdatePreferencesBody): Promise<void> {
    this.authz.assert(actor, 'me.updatePreferences');
    await this.repo.updatePreferences(actor.userId, {
      ...(body.emailReminders !== undefined ? { emailReminders: body.emailReminders } : {}),
      ...(body.emailAnnouncements !== undefined ? { emailAnnouncements: body.emailAnnouncements } : {}),
    });
  }
}
