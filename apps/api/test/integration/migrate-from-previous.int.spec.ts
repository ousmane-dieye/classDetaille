import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectAs, dbConfigFor, execInPg } from '../support/pg.js';
import { API_DIR, makeScratchPrismaProject, runPrisma } from '../support/prisma-cli.js';

const MIGRATIONS = join(API_DIR, 'prisma', 'migrations');
const LAST_PREVIOUS = '20261013000000_foundations';

describe('migration depuis la version précédente (D7)', () => {
  it('une base migrée jusqu’aux fondations reçoit les migrations du lot 1a par migrate deploy', async () => {
    const db = `t_prev_${Date.now().toString(36)}`;
    // Base vierge (rôles et droits de base uniquement), sans migration.
    const boot = await execInPg(['psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-v', `dbname=${db}`, '-f', '/bootstrap/db-bootstrap-database.sql']);
    expect(boot.exitCode).toBe(0);

    // Étape 1 : projet temporaire qui ne contient que les migrations jusqu'aux fondations.
    const cfg = makeScratchPrismaProject({});
    const scratchMigrations = join(cfg, '..', 'migrations');
    const names = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const previous = names.filter((n) => n <= LAST_PREVIOUS);
    expect(previous.at(-1)).toBe(LAST_PREVIOUS);
    for (const n of previous) {
      mkdirSync(join(scratchMigrations, n), { recursive: true });
      cpSync(join(MIGRATIONS, n), join(scratchMigrations, n), { recursive: true });
    }
    const owner = dbConfigFor('cp_owner', db);
    const first = await runPrisma(['migrate', 'deploy'], owner, { configPath: cfg });
    expect(first.code, first.stdout + first.stderr).toBe(0);

    const c1 = await connectAs('cp_owner', db);
    const before = await c1.query(`select to_regclass('app.sync_epoch') is not null as foundations, to_regclass('app.users') is not null as users`);
    await c1.end();
    expect(before.rows[0]).toEqual({ foundations: true, users: false });

    // Étape 2 : toutes les migrations du dépôt.
    const second = await runPrisma(['migrate', 'deploy'], owner);
    expect(second.code, second.stdout + second.stderr).toBe(0);

    const c2 = await connectAs('cp_owner', db);
    try {
      const t = await c2.query(
        `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where nspname = 'app' and relkind = 'r' and relname in ('users','sessions','rate_limit_buckets','role_guard','classes','enrollment_requests','audit_log') order by 1`,
      );
      expect(t.rows.map((r) => r.relname)).toEqual(['audit_log', 'classes', 'enrollment_requests', 'rate_limit_buckets', 'role_guard', 'sessions', 'users']);
      const m = await c2.query(`select migration_name, finished_at is not null as done from app._prisma_migrations order by 1`);
      expect(m.rows).toEqual(names.map((n) => ({ migration_name: n, done: true })));
    } finally { await c2.end(); }
  });
});
