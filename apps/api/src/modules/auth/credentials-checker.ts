import { normalizePassword } from '@classepulse/shared';
import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../http/errors.js';
import { tooManyAttempts } from '../../http/too-many-attempts.js';
import type { UserActor } from '../authz/actor.js';
import { PasswordHasher } from '../users/password-hasher.js';
import { UsersService } from '../users/users.service.js';
import type { ClientContext } from './client-context.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { TurnstileGate } from './turnstile.js';

/** Vérification du mot de passe actuel d'une session : limiteur du lot 1a (R6, un échec compte pour IP + compte), 400 sinon (R15). */
@Injectable()
export class CredentialsChecker {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(LoginRateLimiter) private readonly limiter: LoginRateLimiter,
    @Inject(TurnstileGate) private readonly turnstile: TurnstileGate,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
  ) {}

  async verifyOrThrow(actor: UserActor, password: string, ctx: ClientContext): Promise<void> {
    const user = await this.users.credentialsOf(actor); // action me.changePassword : étudiants et administrateurs
    const keys = this.limiter.keys(ctx.ip, user.email);
    const degraded = this.turnstile.isDegraded();
    const gate = await this.limiter.check(keys, degraded);
    if (gate.kind === 'limited') throw tooManyAttempts(gate.retryAfterSeconds);
    const current = normalizePassword(password);
    const ok = user.passwordHash ? await this.hasher.verify(user.passwordHash, current) : await this.hasher.verifyDummy(current);
    if (!ok) {
      await this.limiter.recordFailure(keys, degraded);
      throw new ApiError(400, 'CURRENT_PASSWORD_INVALID');
    }
    await this.limiter.recordSuccess(keys);
  }
}
