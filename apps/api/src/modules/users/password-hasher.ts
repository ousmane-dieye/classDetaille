import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** Paramètres OWASP (§ 3.2). `algorithm: 2` = Argon2id (l'énumération du paquet est un « const enum », absente à l'exécution). */
export const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const MAX_CONCURRENT_HASHES = 4;

export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

@Injectable()
export class PasswordHasher {
  private readonly slots = new Semaphore(MAX_CONCURRENT_HASHES);
  private dummyHash: Promise<string> | undefined;

  /** Le mot de passe reçu est déjà normalisé (NFKC). */
  hash(normalized: string): Promise<string> {
    return this.slots.run(() => hash(normalized, ARGON2_OPTIONS));
  }

  verify(stored: string, normalized: string): Promise<boolean> {
    return this.slots.run(async () => {
      try { return await verify(stored, normalized); } catch { return false; }
    });
  }

  /** Même coût qu'une vérification réelle, quand l'email est inconnu (§ 3.2). */
  async verifyDummy(normalized: string): Promise<false> {
    this.dummyHash ??= this.hash(randomBytes(32).toString('hex'));
    await this.verify(await this.dummyHash, normalized);
    return false;
  }
}
