import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseReadinessProbe } from './database.module.js';
import type { PrismaService } from './prisma.service.js';

function fakePrisma(state: { ping: boolean; overrides: boolean }) {
  const fake = {
    ping: vi.fn(async () => state.ping),
    hasLogSettingOverrides: vi.fn(async () => state.overrides),
  };
  return { fake, prisma: fake as unknown as PrismaService };
}

describe('DatabaseReadinessProbe (détection G4)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('prête quand la base répond et qu’aucun réglage log_* n’est enregistré', async () => {
    const { prisma, fake } = fakePrisma({ ping: true, overrides: false });
    await expect(new DatabaseReadinessProbe(prisma).check()).resolves.toBe(true);
    expect(fake.hasLogSettingOverrides).toHaveBeenCalledTimes(1);
  });

  it('non prête quand un réglage log_* est enregistré sur un rôle ou sur la base', async () => {
    const { prisma } = fakePrisma({ ping: true, overrides: true });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(new DatabaseReadinessProbe(prisma).check()).resolves.toBe(false);
  });

  it('non prête quand la base ne répond pas', async () => {
    const { prisma } = fakePrisma({ ping: false, overrides: false });
    await expect(new DatabaseReadinessProbe(prisma).check()).resolves.toBe(false);
  });

  it('une seule ligne WARN, sans valeur, par épisode de détection', async () => {
    const state = { ping: true, overrides: true };
    const { prisma } = fakePrisma(state);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const probe = new DatabaseReadinessProbe(prisma);
    await probe.check();
    await probe.check();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(['log_* override detected on role/database']);
    state.overrides = false;
    await expect(probe.check()).resolves.toBe(true);
    state.overrides = true;
    await probe.check();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
