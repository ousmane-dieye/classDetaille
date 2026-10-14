import { describe, expect, it } from 'vitest';
import type { TxClient } from '../../database/prisma.service.js';
import type { AuditRepository, AuditRow } from './audit.repository.js';
import { AuditService } from './audit.service.js';

class FakeRepo { rows: AuditRow[] = []; async insertInTx(_tx: TxClient, row: AuditRow) { this.rows.push(row); } }
const tx = {} as TxClient;
const user = { kind: 'user', userId: '0192b1c4-5d6e-7f80-9a1b-2c3d4e5f6a7b', globalRole: 'USER', sessionId: 's' } as const;
const svc = (repo = new FakeRepo()) => ({ repo, s: new AuditService(repo as unknown as AuditRepository) });

describe('AuditService.recordInTx (§ 2.5)', () => {
  it('écrit l’acteur, l’action, la cible et des métadonnées validées', async () => {
    const { repo, s } = svc();
    await s.recordInTx(tx, user, { action: 'PASSWORD_CHANGED', targetType: 'USER', targetId: user.userId, metadata: { revokedSessions: 2 } });
    expect(repo.rows).toEqual([{ actorUserId: user.userId, action: 'PASSWORD_CHANGED', targetType: 'USER', targetId: user.userId, metadata: { revokedSessions: 2 } }]);
  });
  it('un acteur CLI ou anonyme n’a pas d’identifiant d’utilisateur', async () => {
    const { repo, s } = svc();
    await s.recordInTx(tx, { kind: 'cli', command: 'create-class' }, { action: 'CLASS_CREATED', targetType: 'CLASS', targetId: user.userId, metadata: { via: 'cli' } });
    expect(repo.rows[0]?.actorUserId).toBeNull();
  });
  it('refuse un champ de métadonnées hors schéma (par exemple un email)', async () => {
    await expect(svc().s.recordInTx(tx, user, { action: 'PASSWORD_CHANGED', metadata: { revokedSessions: 1, email: 'a@b.sn' } as never })).rejects.toThrow(/audit metadata/);
  });
  it('refuse une cible incomplète', async () => {
    await expect(svc().s.recordInTx(tx, user, { action: 'PASSWORD_CHANGED', targetType: 'USER', metadata: { revokedSessions: 1 } })).rejects.toThrow(/audit target/);
  });
});
