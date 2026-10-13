import type pg from 'pg';

export async function findInvalidIndexes(client: pg.Client, schema: string): Promise<string[]> {
  const r = await client.query<{ name: string }>(
    `select c.relname as name
       from pg_index i
       join pg_class c on c.oid = i.indexrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and not i.indisvalid
      order by 1`,
    [schema],
  );
  return r.rows.map((row) => row.name);
}
