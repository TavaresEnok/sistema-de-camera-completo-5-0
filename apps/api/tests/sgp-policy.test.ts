import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpf, customerState, parseEvent, sourceTime, statusMap } from '../src/sgp/sgp-policy';

const config = { statusMap: { ATIVO: 'ACTIVE', SUSPENSO: 'SUSPENDED' }, utcOffsetMinutes: -180, planIds: ['10'] };
function event() {
  return { acao: 'cadastrar', data: '09/10/2026 10:00:00.123456', cliente: { id: 1, cpfcnpj: '529.982.247-25', nome: 'Cliente de teste' }, contrato: { id: 2 }, servico: { id: 3, status: 'ATIVO', plano: { id: 10 }, login_password: 'not-persisted' } };
}
test('normalizes CPF and rejects invalid digits', () => {
  assert.equal(cpf('529.982.247-25'), '52998224725');
  for (const value of ['11111111111', '52998224724', '', null]) assert.throws(() => cpf(value));
});
test('preserves access while another customer service remains active', () => {
  assert.equal(customerState(['SUSPENDED', 'ACTIVE'], false), 'ACTIVE');
  assert.equal(customerState(['ACTIVE'], true), 'ARCHIVED');
  assert.equal(customerState([], false), 'SUSPENDED');
  assert.equal(customerState(['ARCHIVED', 'SUSPENDED'], false), 'SUSPENDED');
  assert.equal(customerState(['ARCHIVED'], false), 'ARCHIVED');
});
test('native date uses explicit integration timezone and rejects impossible dates', () => {
  assert.equal(sourceTime('09/10/2026 10:00:00.123456', -180).toISOString(), '2026-10-09T13:00:00.123Z');
  assert.throws(() => sourceTime('31/02/2026 10:00:00', -180));
  assert.throws(() => sourceTime('2026-10-09T10:00:00', -180));
  assert.throws(() => sourceTime('2026-02-31T10:00:00Z', -180));
});
test('unknown statuses and disallowed plans fail closed', () => {
  assert.throws(() => parseEvent({ ...event(), servico: { ...event().servico, status: 'UNKNOWN' } }, config));
  assert.throws(() => parseEvent(event(), { ...config, planIds: ['20'] }));
  assert.throws(() => statusMap({ ATIVO: 'ADMIN' }));
  assert.throws(() => statusMap({ ATIVO: 'ACTIVE', ativo: 'SUSPENDED' }));
});
test('orders SGP events within the same millisecond without discarding microseconds', () => {
  const older = parseEvent(event(), config);
  const newer = parseEvent({ ...event(), data: '09/10/2026 10:00:00.123457' }, config);
  assert.equal(older.sourceAt.getTime(), newer.sourceAt.getTime());
  assert.ok(older.sourceOrder < newer.sourceOrder);
  assert.notEqual(older.payloadHash, newer.payloadHash);
});
test('identical requests hash identically without retaining SGP password', () => {
  const first = parseEvent(event(), config);
  const second = parseEvent({ ...event(), servico: { ...event().servico, login_password: 'different-secret' } }, config);
  assert.equal(first.payloadHash, second.payloadHash);
  assert.equal(JSON.stringify(first).includes('not-persisted'), false);
  assert.notEqual(first.payloadHash, parseEvent({ ...event(), cliente: { ...event().cliente, id: 99 } }, config).payloadHash);
});
