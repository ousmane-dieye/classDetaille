import { Module } from '@nestjs/common';
import { ClassesModule } from '../classes/classes.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { CommonPasswords, loadCommonPasswords } from './common-passwords.js';
import { MeService } from './me.service.js';
import { PasswordHasher } from './password-hasher.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [ClassesModule, MembershipsModule],
  providers: [UsersRepository, UsersService, MeService, PasswordHasher, { provide: CommonPasswords, useFactory: loadCommonPasswords }],
  exports: [UsersService, MeService, PasswordHasher, CommonPasswords],
})
export class UsersModule {}
