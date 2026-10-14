import { describe, expect, it } from 'vitest';
import { PasswordHasher, Semaphore } from './password-hasher.js';

describe('PasswordHasher (§ 3.2 : Argon2id 19 Mio, t=2, p=1)', () => {
  const h = new PasswordHasher();
  it('produit un hachage Argon2id aux paramètres OWASP', async () => {
    expect(await h.hash('une phrase de passe assez longue')).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });
  it('vérifie le bon mot de passe et refuse un autre', async () => {
    const hash = await h.hash('une phrase de passe assez longue');
    await expect(h.verify(hash, 'une phrase de passe assez longue')).resolves.toBe(true);
    await expect(h.verify(hash, 'une phrase de passe assez longuE')).resolves.toBe(false);
  });
  it('un hachage corrompu donne faux, jamais une exception', async () => {
    await expect(h.verify('pas-un-hachage', 'x')).resolves.toBe(false);
  });
  it('verifyDummy renvoie toujours faux', async () => {
    await expect(h.verifyDummy('nimporte quoi du tout')).resolves.toBe(false);
  });
});

describe('Semaphore (au plus 4 calculs simultanés)', () => {
  it('ne dépasse jamais la limite', async () => {
    const s = new Semaphore(4);
    let running = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 12 }, () => s.run(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    })));
    expect(peak).toBe(4);
  });
  it('une nouvelle demande arrivant juste après une libération ne dépasse pas la limite', async () => {
    for (let hops = 0; hops < 10; hops++) {
      const s = new Semaphore(2);
      let running = 0;
      let peak = 0;
      const gates: (() => void)[] = [];
      const task = () => s.run(async () => {
        running++; peak = Math.max(peak, running);
        await new Promise<void>((r) => gates.push(r));
        running--;
      });
      const all = [task(), task(), task()]; // deux en cours, une en attente
      await Promise.resolve();
      gates[0]!(); // libère une place
      for (let i = 0; i < hops; i++) await Promise.resolve();
      all.push(task()); // arrive entre la libération et la reprise de l'attente
      await new Promise((r) => setTimeout(r, 0));
      while (gates.length) gates.shift()!();
      await Promise.all(all);
      expect(peak, `hops=${hops}`).toBeLessThanOrEqual(2);
    }
  });
  it('libère la place même si la tâche échoue', async () => {
    const s = new Semaphore(1);
    await expect(s.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(s.run(async () => 'ok')).resolves.toBe('ok');
  });
});
