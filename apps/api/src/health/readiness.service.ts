import { Inject, Injectable } from '@nestjs/common';

export abstract class ReadinessProbe {
  abstract check(): Promise<boolean>;
}

const PUBLIC_CACHE_MS = 10_000;

@Injectable()
export class ReadinessService {
  private cached: { at: number; status: 'ok' | 'degraded' } | undefined;

  private inFlight: Promise<'ok' | 'degraded'> | undefined;

  constructor(@Inject(ReadinessProbe) private readonly probe: ReadinessProbe) {}

  async isReady(): Promise<boolean> {
    try {
      return await this.probe.check();
    } catch {
      return false;
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
