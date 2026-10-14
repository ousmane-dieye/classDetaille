import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';
import { ApiError, toErrorResponse } from './errors.js';

describe('toErrorResponse', () => {
  it('ApiError : code, champs supplémentaires et en-têtes', () => {
    const r = toErrorResponse(new ApiError(429, 'TOO_MANY_ATTEMPTS', { retryAfter: 5 }, { 'retry-after': '5' }), 'rid');
    expect(r).toEqual({ status: 429, body: { error: { code: 'TOO_MANY_ATTEMPTS', retryAfter: 5 }, requestId: 'rid' }, headers: { 'retry-after': '5' } });
  });
  it('HttpException de Nest : seulement un code générique, jamais le message', () => {
    const r = toErrorResponse(new NotFoundException('Cannot GET /api/secret?token=abc'), 'rid');
    expect(r.body).toEqual({ error: { code: 'NOT_FOUND' }, requestId: 'rid' });
  });
  it('un objet { code } construit par notre code est recopié avec ses champs', () => {
    const r = toErrorResponse(new BadRequestException({ code: 'VALIDATION_FAILED', fields: ['email'] }), 'rid');
    expect(r.body.error).toEqual({ code: 'VALIDATION_FAILED', fields: ['email'] });
  });
  it('ThrottlerException → 429 TOO_MANY_REQUESTS', () => {
    expect(toErrorResponse(new ThrottlerException(), 'rid').body.error.code).toBe('TOO_MANY_REQUESTS');
  });
  // L'adaptateur Fastify de Nest transforme toute FastifyError en `new HttpException(message, statusCode)`
  // avant les filtres : le message (qui peut citer la saisie) n'est jamais recopié, seul le statut compte.
  it.each([
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [400, 'BAD_REQUEST'],
  ])('HttpException issue de Fastify %d → %s, sans le message', (status, code) => {
    const r = toErrorResponse(new HttpException('Unexpected token in JSON: "secret"', status), 'rid');
    expect(r).toEqual({ status, body: { error: { code }, requestId: 'rid' }, headers: {} });
  });
  it('statut sans code générique connu → ERROR', () => {
    expect(toErrorResponse(new HttpException('teapot', 418), 'rid').body).toEqual({ error: { code: 'ERROR' }, requestId: 'rid' });
  });
  it('erreur inconnue → 500 INTERNAL sans message', () => {
    expect(toErrorResponse(new Error('password=hunter2'), 'rid')).toEqual({ status: 500, body: { error: { code: 'INTERNAL' }, requestId: 'rid' }, headers: {} });
  });
  it('erreur portant un statusCode mais qui n’est pas une HttpException → 500 INTERNAL', () => {
    const e = Object.assign(new Error('Unexpected token in JSON: "secret"'), { statusCode: 400, code: 'FST_ERR_CTP_INVALID_JSON_BODY' });
    expect(toErrorResponse(e, 'rid')).toEqual({ status: 500, body: { error: { code: 'INTERNAL' }, requestId: 'rid' }, headers: {} });
  });
});
