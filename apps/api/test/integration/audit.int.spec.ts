import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let app: pg.Client;
beforeAll(async () => { db = await createTestDatabase(); app = await connectAs('cp_app', db); });
afterAll(async () => { await app.end(); });

describe('audit_log (§ 2.5)', () => {
  it('le trigger remplit source, occurred_at et db_login_role', async () => {
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
