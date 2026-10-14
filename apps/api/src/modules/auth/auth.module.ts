import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { AppConfig } from '../../config/load-config.js';
import type { AppOverrides } from '../../http/app.js';
import { AppThrottlerGuard } from '../../http/throttle.js';
import { ClassesModule } from '../classes/classes.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { UsersModule } from '../users/users.module.js';
import { AccountController } from './account.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { RateLimitRepository } from './rate-limit.repository.js';
import { SessionGuard } from './session.guard.js';
import { SessionsRepository } from './sessions.repository.js';
import { SessionsService } from './sessions.service.js';
import { HttpTurnstileVerifier, TurnstileGate, TurnstileVerifier } from './turnstile.js';

@Module({})
export class AuthModule {
  static register(config: AppConfig, o: AppOverrides): DynamicModule {
    return {
      module: AuthModule,
      imports: [UsersModule, ClassesModule, MembershipsModule],
      controllers: [AuthController, AccountController],
      providers: [
        // Ordre des gardes globaux : limitation générale, PUIS session (aucune lecture en base avant la limitation).
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: TurnstileVerifier, useValue: o.turnstile ?? new HttpTurnstileVerifier(config.turnstile.secret, config.turnstile.verifyUrl) },
        TurnstileGate, RateLimitRepository, LoginRateLimiter, SessionsRepository, SessionsService, AuthService,
      ],
      exports: [SessionsService, AuthService],
    };
  }
}
