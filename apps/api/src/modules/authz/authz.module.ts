import { Global, Module } from '@nestjs/common';
import { AuthzService } from './authz.service.js';
import { FreshnessService } from './freshness.service.js';

@Global()
@Module({ providers: [AuthzService, FreshnessService], exports: [AuthzService, FreshnessService] })
export class AuthzModule {}
