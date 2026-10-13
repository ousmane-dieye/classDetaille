import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readPgLogsSince, resetServerLogging, setServerLogging } from '../support/pg-logs.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });
afterEach(async () => { await resetServerLogging(); });
afterAll(async () => {
  await resetServerLogging();
  const c = await connectAs('postgres', 'postgres');
  try {
    const r = await c.query(
      `select current_setting('log_statement') as ls, current_setting('log_parameter_max_length') as l1, current_setting('log_parameter_max_length_on_error') as l2`,
    );
    expect(r.rows[0]).toEqual({ ls: 'none', l1: '0', l2: '0' });
  } finally { await c.end(); }
});

const secret = () => `S3CRET_${randomBytes(12).toString('hex')}`;
const marker = async (c: Awaited<ReturnType<typeof connectAs>>) => {
  const m = `MARK_${randomBytes(6).toString('hex')}`;
  await c.query(`select '${m}'`);
  return m;
};

describe('T-05 — secrets et traces PostgreSQL', () => {
  it('(b) journalisation forcée : le secret n’est jamais dans le texte des instructions ni dans les vues', async () => {
    await setServerLogging({ log_statement: 'all', log_min_duration_statement: '0', log_parameter_max_length: '-1', log_parameter_max_length_on_error: '-1' });
    const s = secret();
    const app = await connectAs('cp_app', db);
    const watcher = await connectAs('postgres', db); // observation seulement : voit toutes les requêtes
    const m = await marker(app);
    let finished = false;
    const running = app.query('select pg_sleep(1.5), length($1::text) as n', [s]).finally(() => { finished = true; });
    const seen: string[] = [];
    for (let i = 0; i < 40 && !finished; i++) {
      const act = await watcher.query(`select query from pg_stat_activity where datname = current_database() and state = 'active' and query like '%pg_sleep%' and pid <> pg_backend_pid()`);
      if (act.rows.length > 0) { seen.push(...act.rows.map((r) => r.query as string)); break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    await running;
    await app.query('select 1/0 where length($1::text) > 0', [s]).catch(() => undefined);
    const stmts = await watcher.query(`select query from public.pg_stat_statements`);
    await app.end(); await watcher.end();
    expect(seen.length, 'la requête active doit avoir été observée').toBeGreaterThan(0);
    const logs = await readPgLogsSince(m);
    const statementLines = logs.split('\n').filter((l) => /(statement|execute|STATEMENT):/.test(l));
    expect(statementLines.join('\n')).not.toContain(s);
    expect(seen.join('\n')).not.toContain(s);
    expect(stmts.rows.map((r) => r.query).join('\n')).not.toContain(s);
    // Dans ce mode, le secret apparaît attendu dans les lignes « parameters: » : preuve des paramètres liés.
    expect(logs).toMatch(/parameters:.*S3CRET_/);
  });

  it('(c) configuration de production + journalisation forcée : aucun secret dans les journaux', async () => {
    await setServerLogging({ log_statement: 'all', log_min_duration_statement: '0', log_parameter_max_length: '0', log_parameter_max_length_on_error: '0' });
    const s = secret();
    const app = await connectAs('cp_app', db);
    const m = await marker(app);
    await app.query('select length($1::text) as n', [s]);
    await app.query('select 1/0 where length($1::text) > 0', [s]).catch(() => undefined);
    await app.end();
    const logs = await readPgLogsSince(m);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(s);
  });

  it('(c, caractérisation) une erreur de conversion recopie la valeur dans le MESSAGE, quels que soient les réglages', async () => {
    await setServerLogging({ log_statement: 'all', log_parameter_max_length: '0', log_parameter_max_length_on_error: '0' });
    const s = secret();
    const app = await connectAs('cp_app', db);
    const m = await marker(app);
    const err = await app.query('select $1::int', [s]).catch((e: Error) => e);
    await app.end();
    expect(String((err as Error).message)).toContain(s);
    expect(await readPgLogsSince(m)).toContain(s);
    // Conséquence (contrainte de conception) : une fonction qui reçoit un secret le prend en text/bytea,
    // sans conversion côté serveur ; le format est validé côté client avant l'appel.
  });

  it('(d) cp_app, cp_ops et cp_monitor ne peuvent pas modifier log_parameter_max_length', async () => {
    for (const role of ['cp_app', 'cp_ops', 'cp_monitor'] as const) {
      const c = await connectAs(role, db);
      await expect(c.query(`set log_parameter_max_length = -1`)).rejects.toMatchObject({ code: '42501' });
      await c.end();
    }
  });

  // EXIGENCE DU BRIEF NON SATISFAITE (constat T-05) : log_parameter_max_length_on_error est de contexte
  // « user » (modifiable par toute session). `it.fails` garde l'exigence visible : ce test passera (et it.fails
  // échouera) le jour où le réglage sera verrouillé. Voir docs/ops/T-05-journaux.md.
  it.fails('(d, exigence) cp_app, cp_ops et cp_monitor ne peuvent pas modifier log_parameter_max_length_on_error', async () => {
    for (const role of ['cp_app', 'cp_ops', 'cp_monitor'] as const) {
      const c = await connectAs(role, db);
      await expect(c.query(`set log_parameter_max_length_on_error = -1`)).rejects.toMatchObject({ code: '42501' });
      await c.end();
    }
  });

  it('(d, caractérisation) une session peut réactiver les paramètres dans le CONTEXT des erreurs', async () => {
    await setServerLogging({ log_statement: 'all' });
    const s = secret();
    const app = await connectAs('cp_app', db);
    const m = await marker(app);
    await app.query('set log_parameter_max_length_on_error = -1');
    await app.query('select 1/0 where length($1::text) > 0', [s]).catch(() => undefined);
    await app.end();
    const logs = await readPgLogsSince(m);
    expect(logs).toContain(`CONTEXT:  unnamed portal with parameters: $1 = '${s}'`);
  });
});
