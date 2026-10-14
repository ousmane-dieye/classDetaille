import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { AuditRepository } from '../../src/modules/audit/audit.repository.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { connectAs, createTestDatabase, dbConfigFor } from '../support/pg.js';

let db: string;
let app: pg.Client;
beforeAll(async () => { db = await createTestDatabase(); app = await connectAs('cp_app', db); });
afterAll(async () => { await app.end(); });

describe('audit_log (§ 2.5)', () => {
  it('le trigger écrase source, occurred_at et db_login_role même si le rôle propriétaire les fournit', async () => {
    const owner = await connectAs('cp_owner', db);
    try {
      const r = await owner.query(
        `insert into app.audit_log (action, source, occurred_at, db_login_role) values ('CLASS_CREATED', 'PRIVILEGED', now() - interval '1 day', 'x')
         returning source, db_login_role, occurred_at > now() - interval '1 minute' as recent`,
      );
      expect(r.rows[0]).toEqual({ source: 'APP', db_login_role: 'cp_owner', recent: true });
    } finally { await owner.end(); }
  });
  it('les valeurs par défaut remplissent source, occurred_at et db_login_role', async () => {
    const r = await app.query(`insert into app.audit_log (action, metadata) values ('CLASS_CREATED', '{"via":"cli"}') returning source, db_login_role, occurred_at is not null as dated`);
    expect(r.rows[0]).toEqual({ source: 'APP', db_login_role: 'cp_app', dated: true });
  });
  it('cp_app ne peut pas choisir la source ni la date', async () => {
    await expect(app.query(`insert into app.audit_log (action, source) values ('CLASS_CREATED', 'PRIVILEGED')`)).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`insert into app.audit_log (action, occurred_at) values ('CLASS_CREATED', now() - interval '1 day')`)).rejects.toMatchObject({ code: '42501' });
  });
  it.each(['ACCOUNT_ANONYMIZED', 'NOTIFICATIONS_PURGED', 'CHAT_PURGED', 'ADMIN_RECOVERY_CODE_ISSUED', 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED', 'DATABASE_RESTORED'])(
    'refuse l’action réservée %s depuis APP', async (action) => {
      await expect(app.query(`insert into app.audit_log (action) values ($1)`, [action])).rejects.toMatchObject({ code: '42501' });
    });
  it('cp_app ne peut ni modifier ni supprimer une entrée', async () => {
    await expect(app.query(`update app.audit_log set metadata = '{}'`)).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`delete from app.audit_log`)).rejects.toMatchObject({ code: '42501' });
  });
  it('métadonnées : objet JSON de 4 Ko au plus', async () => {
    await expect(app.query(`insert into app.audit_log (action, metadata) values ('CLASS_CREATED', '[1]')`)).rejects.toMatchObject({ constraint: 'audit_metadata_object' });
    const big = JSON.stringify({ x: 'a'.repeat(4100) });
    await expect(app.query(`insert into app.audit_log (action, metadata) values ('CLASS_CREATED', $1)`, [big])).rejects.toMatchObject({ constraint: 'audit_metadata_object' });
  });
  it('cible : type et identifiant ensemble, type dans la liste', async () => {
    await expect(app.query(`insert into app.audit_log (action, target_type) values ('CLASS_CREATED', 'CLASS')`)).rejects.toMatchObject({ constraint: 'audit_target' });
    await expect(app.query(`insert into app.audit_log (action, target_type, target_id) values ('CLASS_CREATED', 'FILE', $1)`, [uuidv7()])).rejects.toMatchObject({ constraint: 'audit_target' });
  });
});

describe('AuditService sous cp_app', () => {
  it('écrit une entrée APP dans la transaction ; rien si la transaction échoue', async () => {
    const prisma = new PrismaService(dbConfigFor('cp_app', db));
    const svc = new AuditService(new AuditRepository());
    const cli = { kind: 'cli', command: 'create-class' } as const;
    const kept = uuidv7();
    const rolled = uuidv7();
    try {
      await prisma.withTx((tx) => svc.recordInTx(tx, cli, { action: 'CLASS_CREATED', targetType: 'CLASS', targetId: kept, metadata: { via: 'cli' } }));
      await expect(prisma.withTx(async (tx) => {
        await svc.recordInTx(tx, cli, { action: 'CLASS_CREATED', targetType: 'CLASS', targetId: rolled, metadata: { via: 'cli' } });
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
    } finally {
      await prisma.onModuleDestroy();
    }
    const r = await app.query(`select target_id, source from app.audit_log where target_id = any($1::uuid[])`, [[kept, rolled]]);
    expect(r.rows).toEqual([{ target_id: kept, source: 'APP' }]);
  });
});
