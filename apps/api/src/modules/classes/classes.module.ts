import { Module } from '@nestjs/common';
import { ClassesController } from './classes.controller.js';
import { ClassesRepository } from './classes.repository.js';
import { ClassesService } from './classes.service.js';

@Module({ controllers: [ClassesController], providers: [ClassesRepository, ClassesService], exports: [ClassesService] })
export class ClassesModule {}
