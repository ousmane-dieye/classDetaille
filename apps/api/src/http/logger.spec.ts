import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from './logger.js';

function logOnce(obj: object): string {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  const app = Fastify({ logger: loggerOptions('info', stream) });
  app.log.info(obj, 'm');
  return lines.join('');
}

describe('masquage des codes à usage unique dans les corps (F4)', () => {
  it.each([
    ['req.body.code', { req: { url: '/x', body: { code: '123456' } } }],
    ['body.code', { body: { code: '123456' } }],
    ['x.body.code', { ctx: { body: { code: '123456' } } }],
  ])('%s est masqué', (_n, obj) => {
    expect(logOnce(obj)).not.toContain('123456');
  });
  it('un code d’erreur (error.code, code nu) n’est pas masqué', () => {
    const out = logOnce({ error: { code: 'CODE_INVALID' }, code: 'CODE_LOCKED' });
    expect(out).toContain('CODE_INVALID');
    expect(out).toContain('CODE_LOCKED');
  });
});
