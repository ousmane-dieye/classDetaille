import { Injectable } from '@nestjs/common';

export abstract class ReadinessProbe {
  abstract check(): Promise<boolean>;
}

const PUBLIC_CACHE_MS = 10_000;

@Injectable()
export class ReadinessService {
  private cached: { at: number; status: 'ok' | 'degraded' } | undefined;

  constructor(private readonly probe: ReadinessProbe) {}

  async isReady(): Promise<boolean> {
    try {
      return await this.probe.check();
    } catch {
      return false;
    }
  }

  async publicStatus(): Promise<'ok' | 'degraded'> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < PUBLIC_CACHE_MS) return this.cached.status;
    const status = (await this.isReady()) ? 'ok' : 'degraded';
    this.cached = { at: now, status };
    return status;
  }
}
