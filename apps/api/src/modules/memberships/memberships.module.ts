import { Module } from '@nestjs/common';
import { ClassesModule } from '../classes/classes.module.js';
import { DelegatesController } from './delegates.controller.js';
import { MembersController } from './members.controller.js';
import { MembershipsController } from './memberships.controller.js';
import { MembershipsRepository } from './memberships.repository.js';
import { MembershipsService } from './memberships.service.js';
import { ClassTransfersController, TransfersController } from './transfers.controller.js';

@Module({
  imports: [ClassesModule],
  controllers: [MembershipsController, MembersController, DelegatesController, TransfersController, ClassTransfersController],
  providers: [MembershipsRepository, MembershipsService],
  exports: [MembershipsService],
})
export class MembershipsModule {}
