import { Inject, Injectable, Logger } from '@nestjs/common';
import { ipPrefix } from '../../../http/ip.js';
import { tooManyAttempts } from '../../../http/too-many-attempts.js';
import { BUCKET_ROW_CAP } from '../login-rate-limiter.js';
import { RateLimitRepository } from '../rate-limit.repository.js';

const HOUR = 3600;
export const OTP_REQUESTS_PER_IP_HOUR = 10;
export const OTP_TRIES_PER_IP_HOUR = 30;

/**
 * Seaux par préfixe d'IP (R5) : l'incrément est atomique (INSERT … ON CONFLICT), jamais « lire puis écrire ».
 * Plafond de lignes du lot 1a (D13) : comme pour la limite par IP de la connexion (§ 2.2), la limite par IP reste
 * appliquée au-delà de BUCKET_ROW_CAP seaux vivants (jamais de contournement par rotation de préfixes) ; seule une
 * alerte d'exploitation est émise, une fois.
 */
@Injectable()
export class OtpLimiter {
  private readonly logger = new Logger('OtpLimiter');
  private capWarned = false;

  constructor(@Inject(RateLimitRepository) private readonly repo: RateLimitRepository) {}

  hitRequest(ip: string): Promise<void> { return this.hit(`otp-ip:${ipPrefix(ip)}`, OTP_REQUESTS_PER_IP_HOUR); }
  hitTry(ip: string): Promise<void> { return this.hit(`otp-try-ip:${ipPrefix(ip)}`, OTP_TRIES_PER_IP_HOUR); }

  private async hit(key: string, limit: number): Promise<void> {
    const capped = (await this.repo.rowCountUpTo(BUCKET_ROW_CAP + 1, HOUR)) > BUCKET_ROW_CAP;
    if (capped && !this.capWarned) this.logger.warn(`alert: rate_limit_buckets above ${BUCKET_ROW_CAP} rows, OTP per-IP limits still enforced`);
    this.capWarned = capped;
    const r = await this.repo.hit(key, HOUR);
    if (r.attempts > limit) throw tooManyAttempts(r.resetIn);
  }
}
