import { type ExecutionContext, Inject, Injectable, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { ApiError } from './errors.js';

/**
 * Dépassement → 429 au format commun avec `Retry-After` (§ 4.8). Avec plusieurs limiteurs nommés, la classe
 * de base pose `Retry-After-<nom>` : on lève donc notre propre erreur avec l'en-tête standard.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  // Dépendances déclarées explicitement : @nestjs/throttler (CommonJS) désigne `Reflector` par sa propre copie de
  // @nestjs/core quand l'API tourne sous tsx, que l'injecteur ne reconnaît pas ; on injecte celui de l'application.
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
  ) {
    super(options, storage, reflector);
  }

  protected override async throwThrottlingException(_ctx: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    // timeToBlockExpire est en secondes (ThrottlerStorageService arrondit au supérieur).
    const retryAfter = Math.max(1, Math.ceil(detail.timeToBlockExpire));
    throw new ApiError(429, 'TOO_MANY_REQUESTS', { retryAfter }, { 'retry-after': String(retryAfter) });
  }
}

/** Limitation générale (§ 3.5). Premier garde global : elle passe avant toute lecture en base. */
@Module({ providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }] })
export class ThrottleGuardModule {}
