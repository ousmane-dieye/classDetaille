import { getPgContainer, runSql } from './pg.js';

// Les réglages de production du harnais sont passés sur la ligne de commande du serveur (`-c`), qui PRIME
// sur postgresql.auto.conf : ALTER SYSTEM + pg_reload_conf() n'a donc aucun effet sur eux (mesuré).
// Pour forcer la journalisation, on pose les réglages au niveau du rôle cp_app (superutilisateur requis,
// pris en compte à la connexion suivante) ; ils priment sur la ligne de commande et sont retirés clé par clé
// (cp_app porte d'autres réglages de rôle, voir db-bootstrap-cluster.sql : pas de RESET ALL).
const FORCED_ROLE = 'cp_app';
const KEYS = ['log_statement', 'log_min_duration_statement', 'log_parameter_max_length', 'log_parameter_max_length_on_error'] as const;

export async function setServerLogging(settings: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(settings)) {
    if (!(KEYS as readonly string[]).includes(k)) throw new Error(`réglage non autorisé : ${k}`);
    await runSql('postgres', `ALTER ROLE ${FORCED_ROLE} SET ${k} = '${v}'`);
  }
}

/** Retire les réglages forcés ; les valeurs de production (ligne de commande du serveur) redeviennent effectives. */
export async function resetServerLogging(): Promise<void> {
  for (const k of KEYS) await runSql('postgres', `ALTER ROLE ${FORCED_ROLE} RESET ${k}`);
  await runSql('postgres', 'ALTER SYSTEM RESET ALL');
  await runSql('postgres', 'SELECT pg_reload_conf()');
}

/** Décode le flux Docker multiplexé (en-têtes de 8 octets) ; renvoie le tampon tel quel s'il n'est pas multiplexé. */
export function demuxDockerLogs(buf: Buffer): string {
  const looksMuxed = buf.length >= 8 && buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksMuxed) return buf.toString('utf8');
  const parts: Buffer[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off + 4);
    parts.push(buf.subarray(off + 8, off + 8 + len));
    off += 8 + len;
  }
  return Buffer.concat(parts).toString('utf8');
}

export async function readPgLogsSince(marker: string): Promise<string> {
  const container = await getPgContainer();
  // Laisse le temps au serveur d'écrire ses dernières lignes.
  await new Promise((r) => setTimeout(r, 300));
  const raw = (await container.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
  const all = demuxDockerLogs(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  const i = all.lastIndexOf(marker);
  return i >= 0 ? all.slice(i) : '';
}
