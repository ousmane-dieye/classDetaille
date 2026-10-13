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
      `select s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'cp_app' and s.setdatabase = 0`,
    );
    const cfg = r.rows.flatMap((x) => x.setconfig as string[]).sort();
    expect(cfg).toEqual(['idle_in_transaction_session_timeout=10s', 'transaction_timeout=10s']);
    expect(cfg.some((x) => x.startsWith('log_'))).toBe(false);
  } finally { await c.end(); }
});

const secret = () => `S3CRET_${randomBytes(12).toString('hex')}`;

/** Relit les journaux jusqu'à ce que `ok` soit vrai (délai borné). */
async function logsWhen(m: string, ok: (logs: string) => boolean, timeoutMs = 10_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  let logs = await readPgLogsSince(m);
  while (!ok(logs) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    logs = await readPgLogsSince(m);
  }
  return logs;
}
const marker = async (c: Awaited<ReturnType<typeof connectAs>>) => {
  const m = `MARK_${randomBytes(6).toString('hex')}`;
  await c.query(`select '${m}'`);
  return m;
};
const ERR = /ERROR:\s+division by zero/;
const EXEC = /execute [^:]*:.*length\(\$1::text\)/;

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
    const logs = await logsWhen(m, (l) => EXEC.test(l) && /STATEMENT:/.test(l));
    const statementLines = logs.split('\n').filter((l) => /\b(statement|execute [^:]*|STATEMENT):/.test(l));
    expect(statementLines.some((l) => /execute [^:]*:/.test(l)), 'au moins une ligne execute doit être présente').toBe(true);
    expect(statementLines.join('\n')).not.toContain(s);
    expect(seen.join('\n')).not.toContain(s);
    expect(stmts.rows.map((r) => r.query as string).some((q) => q.includes('pg_sleep')), 'pg_stat_statements doit contenir la requête pg_sleep').toBe(true);
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
    const logs = await logsWhen(m, (l) => ERR.test(l) && EXEC.test(l));
    expect(logs).toMatch(ERR);
    expect(logs).toMatch(EXEC);
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
    expect(await logsWhen(m, (l) => l.includes(s))).toContain(s);
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

  it('(d2, caractérisation) log_parameter_max_length_on_error est de contexte « user » : une session cp_app peut le modifier', async () => {
    const c = await connectAs('cp_app', db);
    const ctx = await c.query(`select context from pg_settings where name = 'log_parameter_max_length_on_error'`);
    expect(ctx.rows[0].context).toBe('user');
    await expect(c.query(`set log_parameter_max_length_on_error = -1`)).resolves.toBeDefined();
    await c.end();
  });

  it('(d3, caractérisation) la modification ne vaut que pour la session qui l’a faite', async () => {
    await setServerLogging({ log_statement: 'all' });
    const sA = secret();
    const sB = secret();
    const a = await connectAs('cp_app', db);
    const b = await connectAs('cp_app', db);
    const m = await marker(b);
    await a.query('set log_parameter_max_length_on_error = -1');
    await a.query('select 1/0 where length($1::text) > 0', [sA]).catch(() => undefined);
    await b.query('select 1/0 where length($1::text) > 0', [sB]).catch(() => undefined);
    await a.end(); await b.end();
    const logs = await logsWhen(m, (l) => (l.match(/ERROR:\s+division by zero/g) ?? []).length >= 2);
    expect((logs.match(/ERROR:\s+division by zero/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(logs).toContain(`$1 = '${sA}'`); // preuve : la capture fonctionne, la session A fuit ses propres valeurs
    expect(logs).not.toContain(sB);
  });
});
