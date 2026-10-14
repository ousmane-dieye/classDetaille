import { describe, expect, it } from 'vitest';
import { ipPrefix, trustProxyHops } from './ip.js';

describe('ipPrefix (§ 2.2 : préfixe /64 en IPv6)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::'],
    ['2001:0DB8:0001:0002::1', '2001:db8:1:2::'],
    ['2001:db8::1', '2001:db8:0:0::'],
    ['::1', '0:0:0:0::'],
  ])('%s → %s', (ip, expected) => {
    expect(ipPrefix(ip)).toBe(expected);
  });
  it('refuse une valeur qui n’est pas une IP', () => {
    expect(() => ipPrefix('localhost')).toThrow();
  });
});

describe('trustProxyHops (TRUST_PROXY)', () => {
  it('0 : aucun mandataire cru', () => {
    expect(trustProxyHops(0)).toBe(false);
  });
  it('n : seuls les n sauts les plus proches sont crus', () => {
    const fn = trustProxyHops(2);
    if (fn === false) throw new Error('fonction attendue');
    expect([0, 1, 2, 3].map((i) => fn('10.0.0.1', i))).toEqual([true, true, false, false]);
  });
});
