import { describe, expect, it } from 'vitest';
import { csrfDecision, isJsonContentType } from './csrf.js';

const APP = 'https://classepulse.example';

describe('csrfDecision (§ 3.5, refus par défaut)', () => {
  it.each([
    [APP, undefined, 'accept'],
    [APP, 'cross-site', 'accept'], // Sec-Fetch-Site ignoré quand Origin est présent
    ['https://evil.example', 'same-origin', 'reject'],
    ['null', undefined, 'reject'],
    [`${APP}:443`, undefined, 'reject'], // comparaison exacte
    [undefined, 'same-origin', 'accept'],
    [undefined, 'same-site', 'reject'],
    [undefined, 'none', 'reject'],
    [undefined, undefined, 'reject'],
  ] as const)('Origin=%s Sec-Fetch-Site=%s → %s', (origin, site, expected) => {
    expect(csrfDecision(origin, site, APP)).toBe(expected);
  });
});

describe('isJsonContentType', () => {
  it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])('accepte %s', (ct) => {
    expect(isJsonContentType(ct)).toBe(true);
  });
  it.each([undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp'])('refuse %s', (ct) => {
    expect(isJsonContentType(ct)).toBe(false);
  });
});
