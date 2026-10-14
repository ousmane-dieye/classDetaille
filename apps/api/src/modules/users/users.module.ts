import { Module } from '@nestjs/common';
import { CommonPasswords, loadCommonPasswords } from './common-passwords.js';
import { PasswordHasher } from './password-hasher.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  providers: [UsersRepository, UsersService, PasswordHasher, { provide: CommonPasswords, useFactory: loadCommonPasswords }],
  exports: [UsersService, PasswordHasher, CommonPasswords],
})
export class UsersModule {}
