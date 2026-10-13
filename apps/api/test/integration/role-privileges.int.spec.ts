import { beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });

async function expectDenied(role: 'cp_app' | 'cp_ops' | 'cp_monitor', sql: string, code = '42501'): Promise<void> {
  const c = await connectAs(role, db);
  try {
    await expect(c.query(sql)).rejects.toMatchObject({ code });
  } finally {
    await c.end();
  }
}

describe('droits de cp_app (§ 2.1, § 2.6)', () => {
  it('ne peut pas créer de table dans app', () => expectDenied('cp_app', 'create table app.x (id int)'));
  it('ne peut pas créer de table dans public', () => expectDenied('cp_app', 'create table public.x (id int)'));
  it('ne peut pas créer de table temporaire', () => expectDenied('cp_app', 'create temp table x (id int)'));
  it('ne peut pas prendre le rôle cp_privileged', () => expectDenied('cp_app', 'set role cp_privileged'));
  it('ne peut pas désactiver les triggers', () => expectDenied('cp_app', "set session_replication_role = 'replica'"));
  it('ne peut pas modifier sync_epoch', () => expectDenied('cp_app', 'update app.sync_epoch set epoch = gen_random_uuid()'));
  it('ne peut pas lire le schéma priv', () => expectDenied('cp_app', 'select 1 from priv.nothing', '42501'));
  it('peut lire sync_epoch', async () => {
    const c = await connectAs('cp_app', db);
    try {
      const r = await c.query('select epoch from app.sync_epoch where id = 1');
      expect(r.rowCount).toBe(1);
    } finally {
      await c.end();
    }
  });
});
