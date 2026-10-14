import { Module } from '@nestjs/common';
import { MembershipsRepository } from './memberships.repository.js';
import { MembershipsService } from './memberships.service.js';

@Module({ providers: [MembershipsRepository, MembershipsService], exports: [MembershipsService] })
export class MembershipsModule {}
