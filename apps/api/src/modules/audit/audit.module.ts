import { Global, Module } from '@nestjs/common';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({ providers: [AuditRepository, AuditService], exports: [AuditService] })
export class AuditModule {}
