import { Inject, Injectable } from '@nestjs/common';

export abstract class ReadinessProbe {
  abstract check(): Promise<boolean>;
}

const PUBLIC_CACHE_MS = 10_000;
/** Délai maximal d'une sonde : au-delà, l'API est déclarée non prête. */
export const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class ReadinessService {
  private cached: { at: number; status: 'ok' | 'degraded' } | undefined;

  private inFlight: Promise<'ok' | 'degraded'> | undefined;

  constructor(@Inject(ReadinessProbe) private readonly probe: ReadinessProbe) {}

  /** Vrai si la sonde répond « prête » en moins de PROBE_TIMEOUT_MS ; une erreur ou un dépassement donne « non prête ». */
  async isReady(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS); });
    try {
      return await Promise.race([this.probe.check(), timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  publicStatus(): Promise<'ok' | 'degraded'> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < PUBLIC_CACHE_MS) return Promise.resolve(this.cached.status);
    // Une seule sonde en vol : les appels concurrents partagent la même promesse.
    this.inFlight ??= this.isReady()
      .then((ok) => {
        const status = ok ? 'ok' : 'degraded';
        this.cached = { at: Date.now(), status };
        return status;
      })
      .finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
}
