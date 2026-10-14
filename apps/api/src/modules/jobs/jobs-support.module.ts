import { Module } from '@nestjs/common';
import { JobLeaseRepository } from './job-lease.repository.js';
import { JobLeaseService } from './job-lease.service.js';

@Module({ providers: [JobLeaseRepository, JobLeaseService], exports: [JobLeaseService] })
export class JobsSupportModule {}
