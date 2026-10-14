import { expect } from 'vitest';
import { connectAs } from './pg.js';

/** Clé « table|privilège|colonne » des listes attendues écrites à la main. */
export const privKey = (table: string, privilege: string, column = '') => `${table}|${privilege}|${column}`;

/**
 * Compare le catalogue réel des droits de cp_app (droits de table et droits par colonne) à une liste exacte écrite à la main.
 * `information_schema.column_privileges` inclut les droits issus d'un droit de table.
 */
export async function expectExactCpAppPrivileges(
  db: string, tables: string[], tableGrants: string[], columnGrants: string[],
  /** Droits de cp_privileged (fonctions SECURITY DEFINER de priv) : liste exacte écrite à la main, vide par défaut. */
  privileged: { tableGrants: string[]; columnGrants: string[] } = { tableGrants: [], columnGrants: [] },
): Promise<void> {
  const list = tables.map((t) => `'${t}'`).join(',');
  const owner = await connectAs('cp_owner', db);
  try {
    const t = await owner.query(
      `select grantee, table_name, privilege_type, is_grantable from information_schema.role_table_grants
        where table_schema = 'app' and table_name in (${list}) and grantee <> 'cp_owner'`,
    );
    expect(t.rows.every((x) => ['cp_app', 'cp_privileged'].includes(x.grantee) && x.is_grantable === 'NO')).toBe(true);
    expect(t.rows.filter((x) => x.grantee === 'cp_privileged').map((x) => privKey(x.table_name, x.privilege_type)).sort()).toEqual([...privileged.tableGrants].sort());
    expect(t.rows.filter((x) => x.grantee === 'cp_app').map((x) => privKey(x.table_name, x.privilege_type)).sort()).toEqual([...tableGrants].sort());
    const c = await owner.query(
      `select grantee, table_name, column_name, privilege_type, is_grantable from information_schema.column_privileges
        where table_schema = 'app' and table_name in (${list}) and grantee <> 'cp_owner'`,
    );
    expect(c.rows.every((x) => ['cp_app', 'cp_privileged'].includes(x.grantee) && x.is_grantable === 'NO')).toBe(true);
    expect(c.rows.filter((x) => x.grantee === 'cp_privileged').map((x) => privKey(x.table_name, x.privilege_type, x.column_name)).sort()).toEqual([...privileged.columnGrants].sort());
    expect(c.rows.filter((x) => x.grantee === 'cp_app').map((x) => privKey(x.table_name, x.privilege_type, x.column_name)).sort()).toEqual([...columnGrants].sort());
  } finally { await owner.end(); }
}
