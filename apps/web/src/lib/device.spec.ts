import { describe, expect, it } from 'vitest';
import { describeUserAgent } from './device';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/109.0 Firefox/119.0';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const EDGE_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

describe('describeUserAgent (M14)', () => {
  it('nomme le navigateur et le système, comme « Chrome · Android » dans la maquette', () => {
    expect(describeUserAgent(CHROME_WINDOWS)).toBe('Chrome · Windows');
    expect(describeUserAgent(FIREFOX_ANDROID)).toBe('Firefox · Android');
    expect(describeUserAgent(SAFARI_IPHONE)).toBe('Safari · iPhone');
  });

  it('ne confond pas Edge avec Chrome (Chrome apparaît aussi dans Edge)', () => {
    expect(describeUserAgent(EDGE_WINDOWS)).toBe('Edge · Windows');
  });

  it('ne devine rien sans userAgent', () => {
    expect(describeUserAgent('')).toBe('Appareil non identifié');
  });

  it('reste honnête quand l’agent est inconnu', () => {
    expect(describeUserAgent('QuelqueBizarre/1.0')).toBe('Navigateur · système');
  });
});
