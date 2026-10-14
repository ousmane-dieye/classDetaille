import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../http/clock.js';

export type VerifierResult = 'valid' | 'invalid' | 'error' | 'timeout';
export const TURNSTILE_TIMEOUT_MS = 3_000;
export const DEGRADED_RETRY_MS = 60_000;
const ERRORS_BEFORE_DEGRADED = 3;

export abstract class TurnstileVerifier {
  abstract verify(token: string, ip: string): Promise<VerifierResult>;
}

export class HttpTurnstileVerifier extends TurnstileVerifier {
  constructor(private readonly secret: string, private readonly url: string, private readonly timeoutMs = TURNSTILE_TIMEOUT_MS) { super(); }

  async verify(token: string, ip: string): Promise<VerifierResult> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        body: new URLSearchParams({ secret: this.secret, response: token, remoteip: ip }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return 'error';
      const body = (await res.json()) as { success?: unknown };
      return body.success === true ? 'valid' : 'invalid';
    } catch (e) {
      return e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'error';
    }
  }
}

/** Mode dégradé (arbitrage M) : 3 erreurs consécutives ou un délai dépassé ; nouvel essai après 60 s (R7). */
@Injectable()
export class TurnstileGate {
  private readonly logger = new Logger('Turnstile');
  private consecutiveErrors = 0;
  private degradedSince: number | null = null;

  constructor(@Inject(TurnstileVerifier) private readonly verifier: TurnstileVerifier, @Inject(Clock) private readonly clock: Clock) {}

  isDegraded(): boolean {
    return this.degradedSince !== null && this.clock.now().getTime() - this.degradedSince < DEGRADED_RETRY_MS;
  }

  async check(token: string | undefined, ip: string): Promise<'valid' | 'invalid' | 'unavailable'> {
    if (this.isDegraded()) return 'unavailable';
    if (!token) return 'invalid';
    const r = await this.verifier.verify(token, ip);
    if (r === 'valid' || r === 'invalid') {
      this.consecutiveErrors = 0;
      if (this.degradedSince !== null) {
        this.degradedSince = null;
        this.logger.log('turnstile recovered');
      }
      return r;
    }
    this.consecutiveErrors++;
    if (r === 'timeout' || this.consecutiveErrors >= ERRORS_BEFORE_DEGRADED) this.enterDegraded();
    return 'unavailable';
  }

  private enterDegraded(): void {
    this.degradedSince = this.clock.now().getTime();
    // Alerte d'exploitation (§ 3.2) : un événement nommé, sans donnée de la requête.
    this.logger.warn('alert: turnstile unavailable, degraded login limits active');
  }
}
