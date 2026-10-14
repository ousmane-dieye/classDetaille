import { connectAs } from './pg.js';

/** Attend (5 s au plus) qu'une session `cp_app` autre que `holderPid` soit en attente d'un verrou ; observation par `postgres`. */
export async function waitForLockWait(db: string, holderPid: number): Promise<void> {
  const admin = await connectAs('postgres', db);
  try {
    for (let i = 0; i < 100; i++) {
      const r = await admin.query(
        `select count(*)::int as n from pg_stat_activity where datname = $1 and usename = 'cp_app' and pid <> $2 and wait_event_type = 'Lock'`,
        [db, holderPid]);
      if (r.rows[0].n > 0) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('aucune attente de verrou observée');
  } finally {
    await admin.end();
  }
}
