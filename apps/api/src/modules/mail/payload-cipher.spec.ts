import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PayloadCipher } from './payload-cipher.js';

const key = Buffer.alloc(32, 9);
describe('PayloadCipher (R13)', () => {
  it('aller-retour', () => {
    const c = new PayloadCipher(key);
    const id = randomUUID();
    expect(c.decrypt(id, c.encrypt(id, { code: '123456' }))).toEqual({ code: '123456' });
  });
  it('deux chiffrements du même contenu diffèrent, et le code n’apparaît pas en clair', () => {
    const c = new PayloadCipher(key);
    const id = randomUUID();
    const a = c.encrypt(id, { code: '123456' });
    const b = c.encrypt(id, { code: '123456' });
    expect(a.equals(b)).toBe(false);
    expect(a.toString('latin1')).not.toContain('123456');
  });
  it('un contenu recopié dans une autre ligne ne se déchiffre pas', () => {
    const c = new PayloadCipher(key);
    expect(() => c.decrypt(randomUUID(), c.encrypt(randomUUID(), { code: '1' }))).toThrow();
  });
  it('une altération est détectée', () => {
    const c = new PayloadCipher(key);
    const id = randomUUID();
    const data = c.encrypt(id, { code: '123456' });
    data[data.length - 1] = data[data.length - 1]! ^ 1;
    expect(() => c.decrypt(id, data)).toThrow();
  });
  it('une autre clé ne déchiffre pas ; une clé de mauvaise taille est refusée', () => {
    const id = randomUUID();
    const data = new PayloadCipher(key).encrypt(id, { code: '1' });
    expect(() => new PayloadCipher(Buffer.alloc(32, 1)).decrypt(id, data)).toThrow();
    expect(() => new PayloadCipher(Buffer.alloc(16))).toThrow();
  });
  it('IV de 12 octets aléatoire, étiquette de 16 ; données trop courtes refusées', () => {
    const c = new PayloadCipher(key);
    const id = randomUUID();
    const a = c.encrypt(id, { code: '1' });
    const b = c.encrypt(id, { code: '1' });
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
    expect(a.length).toBe(12 + 16 + JSON.stringify({ code: '1' }).length);
    expect(() => c.decrypt(id, a.subarray(0, 20))).toThrow('payload decryption failed');
  });
  it('l’erreur de déchiffrement ne contient ni le contenu ni la clé', () => {
    const id = randomUUID();
    const data = new PayloadCipher(key).encrypt(id, { code: '987654' });
    let caught: Error | undefined;
    try {
      new PayloadCipher(Buffer.alloc(32, 1)).decrypt(id, data);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toBe('payload decryption failed');
    expect(`${caught!.message}${caught!.stack}`).not.toContain('987654');
    expect(`${caught!.message}${caught!.stack}`).not.toContain(key.toString('hex'));
  });
});
