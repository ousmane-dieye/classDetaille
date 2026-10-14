import { isIPv4, isIPv6 } from 'node:net';

function expandV6(ip: string): number[] {
  const hasGap = ip.includes('::');
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = hasGap && tail ? tail.split(':') : [];
  const fill = hasGap ? Array<string>(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}

/**
 * TRUST_PROXY = nombre de mandataires inverses de confiance devant l'API. Fastify 5 ignore désormais un nombre
 * (aucun saut n'est cru) : on lui passe la fonction équivalente, qui croit les `hops` adresses les plus proches
 * (la connexion elle-même, puis les dernières entrées de X-Forwarded-For). À n'utiliser que si l'API n'est
 * joignable qu'au travers de ces mandataires.
 */
export function trustProxyHops(hops: number): false | ((addr: string, i: number) => boolean) {
  return hops === 0 ? false : (_addr, i) => i < hops;
}

/** Clé de limitation d'une IP : l'adresse IPv4 entière, ou le préfixe /64 d'une IPv6 (§ 2.2). */
export function ipPrefix(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) throw new Error('not an IP address');
  return `${expandV6(ip.toLowerCase()).slice(0, 4).map((g) => g.toString(16)).join(':')}::`;
}
