import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError } from 'axios';
import { clientError } from '../src/lib/client-error.ts';

const httpError = (status: number, message = 'Internal infrastructure detail') => new AxiosError('Request failed', undefined, undefined, undefined, { status, data: { message } } as any);
test('mensagens de erro não revelam infraestrutura ou códigos HTTP ao cliente', () => {
  for (const status of [401, 403, 404, 409, 413, 429, 500, 502]) {
    const message = clientError(httpError(status), 'Não foi possível salvar.');
    assert.doesNotMatch(message, /Internal|Request failed|status code|infrastructure/);
    assert.notEqual(message.length, 0);
  }
  assert.match(clientError(new AxiosError('Network Error'), 'Falha'), /Verifique sua conexão/);
  assert.equal(clientError(new Error('rtsp://credential@internal'), 'Não foi possível salvar.'), 'Não foi possível salvar.');
});
test('senha forte: orientação simples, sem repassar validações internas', () => {
  assert.match(clientError(httpError(400, 'Senha fraca: internal dto'), 'Falha'), /12 caracteres/);
  assert.equal(clientError(httpError(400, 'SQL implementation detail'), 'Confira os dados.'), 'Confira os dados.');
});
