import { Module } from '@nestjs/common';
import { MaintenanceRepository } from './maintenance.repository.js';
import { MaintenanceService } from './maintenance.service.js';

@Module({ providers: [MaintenanceRepository, MaintenanceService], exports: [MaintenanceService] })
export class MaintenanceModule {}
