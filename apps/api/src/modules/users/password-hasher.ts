import { randomBytes } from 'node:crypto';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** Paramètres OWASP (§ 3.2). `algorithm: 2` = Argon2id (l'énumération du paquet est un « const enum », absente à l'exécution). */
export const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const MAX_CONCURRENT_HASHES = 4;

export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      // La place est cédée directement à l'attente : `active` ne baisse pas, aucune demande ne peut s'intercaler.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

@Injectable()
export class PasswordHasher implements OnApplicationBootstrap {
  private readonly slots = new Semaphore(MAX_CONCURRENT_HASHES);
  private readonly logger = new Logger(PasswordHasher.name);
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

  /** Report du lot 1a : le hachage factice est prêt avant la première requête (aucun écart de durée à la première connexion inconnue). */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.verifyDummy('warm-up');
    } catch {
      // Le démarrage ne dépend pas du préchauffage : le hachage factice sera recalculé à la première utilisation.
      this.logger.warn('Préchauffage du hachage factice impossible ; il sera recalculé à la première utilisation');
    }
  }

  /** Même coût qu'une vérification réelle, quand l'email est inconnu (§ 3.2). */
  async verifyDummy(normalized: string): Promise<false> {
    if (!this.dummyHash) {
      const computing = this.hash(randomBytes(32).toString('hex'));
      this.dummyHash = computing;
      computing.catch(() => { if (this.dummyHash === computing) this.dummyHash = undefined; });
    }
    await this.verify(await this.dummyHash, normalized);
    return false;
  }
}
