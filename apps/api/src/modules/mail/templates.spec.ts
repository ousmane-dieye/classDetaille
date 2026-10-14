import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMAIL_KINDS, SECRET_KINDS, SECURITY_KINDS } from './email-kinds.js';
import { RenderError, renderEmail } from './templates.js';

const ctx = { appOrigin: 'https://app.test' };
const TOKEN = 'T'.repeat(43);
const cases = [
  ['ADMIN_OTP', { purpose: 'LOGIN' }, { code: '123456' }],
  ['ADMIN_OTP', { purpose: 'STEP_UP' }, { code: '123456' }],
  ['ADMIN_EMAIL_CHANGE_OLD', { newEmail: 'nouveau@example.com' }, { code: '123456' }],
  ['ADMIN_EMAIL_CHANGE_NEW', {}, { code: '123456' }],
  ['PASSWORD_RESET', {}, { token: TOKEN }],
  ['SECURITY_ALERT', { event: 'PASSWORD_RESET' }, null],
  ['SECURITY_ALERT', { event: 'EMAIL_CHANGED' }, null],
  ['ADMIN_SECURITY_ALERT', { event: 'SECOND_FACTOR_FAILURES', accountEmail: 'a@example.com', failures: 3 }, null],
  ['ADMIN_SECURITY_ALERT', { event: 'SECOND_FACTOR_BLOCKED', accountEmail: 'a@example.com' }, null],
  ['ADMIN_SECURITY_ALERT', { event: 'EMAIL_CHANGED', accountEmail: 'a@example.com' }, null],
  ['ADMIN_SECURITY_ALERT', { event: 'RECOVERY_CODE_ISSUED', accountEmail: 'a@example.com' }, null],
  ['TEST', {}, null],
] as const;

describe('renderEmail', () => {
  it.each(cases)('%s %j : sujet et texte non vides, tutoiement', (kind, payload, secret) => {
    const r = renderEmail(kind, payload, secret, ctx);
    expect(r.subject.length).toBeGreaterThan(3);
    expect(r.text.length).toBeGreaterThan(20);
    expect(`${r.subject}\n${r.text}`).not.toMatch(/\b(vous|votre|vos)\b/i);
  });
  it('le code figure dans le texte, jamais dans le sujet', () => {
    const r = renderEmail('ADMIN_OTP', { purpose: 'LOGIN' }, { code: '123456' }, ctx);
    expect(r.text).toContain('123456');
    expect(r.subject).not.toContain('123456');
    expect(r.text).toContain('10 minutes');
  });
  it('le lien de réinitialisation met le jeton dans le fragment (R8)', () => {
    const r = renderEmail('PASSWORD_RESET', {}, { token: TOKEN }, ctx);
    expect(r.text).toContain(`https://app.test/reinitialiser-mot-de-passe#token=${TOKEN}`);
    expect(r.subject).not.toContain(TOKEN);
    expect(r.text).toContain('30 minutes');
  });
  it('un champ inconnu, un secret manquant ou mal formé fait échouer le rendu', () => {
    expect(() => renderEmail('ADMIN_OTP', { purpose: 'LOGIN', extra: 1 }, { code: '123456' }, ctx)).toThrow(RenderError);
    expect(() => renderEmail('ADMIN_OTP', { purpose: 'LOGIN' }, null, ctx)).toThrow(RenderError);
    expect(() => renderEmail('ADMIN_OTP', { purpose: 'LOGIN' }, { code: '12' }, ctx)).toThrow(RenderError);
  });
  it('un type sans modèle au lot 1b échoue en RenderError (R13)', () => {
    for (const k of ['WELCOME', 'REFUSAL', 'DIGEST', 'ANNOUNCEMENT', 'ADMIN_ALERT'] as const) expect(() => renderEmail(k, {}, null, ctx)).toThrow(RenderError);
  });
});

describe('types d’email', () => {
  it('les types de sécurité sont exactement ceux que la spec exempte de bulk_email_paused', () => {
    expect([...SECURITY_KINDS].sort()).toEqual(['ADMIN_EMAIL_CHANGE_NEW', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_OTP', 'ADMIN_SECURITY_ALERT', 'PASSWORD_RESET', 'SECURITY_ALERT']);
    expect(EMAIL_KINDS).toHaveLength(12);
  });
  it('l’énumération et les types à secret sont ceux de la migration SQL', () => {
    const sql = readFileSync(new URL('../../../prisma/migrations/20261014000300_email_outbox/migration.sql', import.meta.url), 'utf8');
    const enumBody = /CREATE TYPE app\.email_kind AS ENUM \(([^)]*)\)/.exec(sql)![1]!;
    const sqlKinds = [...enumBody.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(sqlKinds).toEqual([...EMAIL_KINDS]);
    const check = /email_outbox_secret_kinds CHECK \(([\s\S]*?)\n {2}\)/.exec(sql)![1]!;
    const secretList = /kind NOT IN \(([^)]*)\)/.exec(check)![1]!;
    const sqlSecret = [...secretList.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(sqlSecret).toEqual([...SECRET_KINDS].sort());
  });
});
