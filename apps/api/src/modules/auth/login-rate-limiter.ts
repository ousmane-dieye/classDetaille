import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/load-config.js';
import { ipPrefix } from '../../http/ip.js';
import { RateLimitRepository } from './rate-limit.repository.js';

export const WINDOW_SECONDS = 900;
export const ACCOUNT_LIMIT = 5;
export const TURNSTILE_AFTER_FAILURES = 3;
export const IP_ALERT_FAILURES = 50;
export const BUCKET_ROW_CAP = 50_000;
export const DEGRADED_LIMITS = { ip: 5, account: 2 } as const;

export type LoginKeys = { ipKey: string; accountKey: string };
export type Gate = { kind: 'allowed'; turnstileRequired: boolean } | { kind: 'limited'; retryAfterSeconds: number };

/** R5 : après le n-ième échec, attendre min(2^(n-1), 30) s. */
export function backoffSeconds(failures: number): number {
  return failures <= 0 ? 0 : Math.min(2 ** (failures - 1), 30);
}

/**
 * Limitation de la connexion (§ 3.2). Un compte n'est jamais bloqué en tant que tel : seuls les seaux
 * « IP » et « IP + compte » existent, de sorte qu'un tiers ne peut bloquer le titulaire depuis une autre IP.
 */
@Injectable()
export class LoginRateLimiter {
  private readonly logger = new Logger('LoginRateLimiter');
  private capWarned = false;

  constructor(@Inject(RateLimitRepository) private readonly repo: RateLimitRepository, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** `normalizedEmail` : forme de normalizeEmail ; seul son HMAC entre dans la clé. */
  keys(ip: string, normalizedEmail: string): LoginKeys {
    const prefix = ipPrefix(ip);
    const mac = createHmac('sha256', this.config.security.rateLimitHmacKey).update(normalizedEmail).digest('hex');
    return { ipKey: `ip:${prefix}`, accountKey: `ip+acct:${prefix}:${mac}` };
  }

  /**
   * Réserve la tentative (atomique) : le seau IP + compte compte l'essai comme un échec dès maintenant, de sorte que
   * des tentatives parallèles ne dépassent ni la limite, ni le délai croissant. recordSuccess l'efface.
   * Turnstile est exigé si au moins 3 échecs précèdent cette tentative.
   */
  async check(keys: LoginKeys, degraded: boolean): Promise<Gate> {
    const ipLimit = degraded ? DEGRADED_LIMITS.ip : this.config.limits.loginPerIp;
    const accountLimit = degraded ? DEGRADED_LIMITS.account : ACCOUNT_LIMIT;
    const ip = await this.repo.hit(keys.ipKey, WINDOW_SECONDS);
    if (ip.attempts > ipLimit) return { kind: 'limited', retryAfterSeconds: Math.max(1, ip.resetIn) };
    if ((await this.repo.rowCountUpTo(BUCKET_ROW_CAP + 1, WINDOW_SECONDS)) > BUCKET_ROW_CAP) {
      // Au-delà de 50 000 lignes, seule la limite par IP s'applique (§ 2.2).
      if (!this.capWarned) this.logger.warn(`alert: rate_limit_buckets above ${BUCKET_ROW_CAP} rows, per-account limit suspended`);
      this.capWarned = true;
      return { kind: 'allowed', turnstileRequired: false };
    }
    this.capWarned = false;
    const after = await this.repo.reserveAccountAttempt(keys.accountKey, WINDOW_SECONDS, accountLimit);
    if (after !== null) return { kind: 'allowed', turnstileRequired: !degraded && after - 1 >= TURNSTILE_AFTER_FAILURES };
    const acct = await this.repo.readFailures(keys.accountKey, WINDOW_SECONDS);
    if (!acct) return { kind: 'limited', retryAfterSeconds: 1 };
    if (acct.failures >= accountLimit) return { kind: 'limited', retryAfterSeconds: Math.max(1, acct.resetIn) };
    return { kind: 'limited', retryAfterSeconds: Math.max(1, Math.ceil((backoffSeconds(acct.failures) * 1000 - acct.sinceLastMs) / 1000)) };
  }

  /** Le compte du seau IP + compte est déjà fait par check() ; ici : échec par IP (alerte) et exigence Turnstile suivante. */
  async recordFailure(keys: LoginKeys, degraded: boolean): Promise<{ turnstileRequired: boolean }> {
    await this.countIpFailure(keys);
    const acct = await this.repo.readFailures(keys.accountKey, WINDOW_SECONDS);
    return { turnstileRequired: !degraded && (acct?.failures ?? 0) >= TURNSTILE_AFTER_FAILURES };
  }

  /** Un rejet « Turnstile exigé » est un échec d'IP comme un mauvais mot de passe (§ 3.2, alerte au-delà de 50 en 15 min). */
  async recordTurnstileRejection(keys: LoginKeys): Promise<void> {
    await this.countIpFailure(keys);
  }

  private async countIpFailure(keys: LoginKeys): Promise<void> {
    const ipFailures = await this.repo.addIpFailure(keys.ipKey);
    // Alerte d'exploitation au passage du seuil (§ 3.2), une fois par fenêtre.
    if (ipFailures === IP_ALERT_FAILURES + 1) this.logger.warn(`alert: login failures above ${IP_ALERT_FAILURES} for ${keys.ipKey} in 15 min`);
  }

  async recordSuccess(keys: LoginKeys): Promise<void> {
    await this.repo.clear(keys.accountKey);
  }
}
