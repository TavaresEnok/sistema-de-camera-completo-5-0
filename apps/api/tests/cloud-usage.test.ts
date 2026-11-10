import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diasDoPainel, preencherDias } from '../src/cloud-storage/cloud-usage.helper';

test('dias do painel: padrão 14, limite 1..90', () => {
  assert.equal(diasDoPainel(undefined), 14);
  assert.equal(diasDoPainel('30'), 30);
  assert.equal(diasDoPainel(500), 90);
  assert.equal(diasDoPainel(0), 1);
});

test('série diária contínua, com zeros nos dias sem envio', () => {
  const s = preencherDias([{ day: '2026-11-09', bytes: 100, count: 2 }], 3, '2026-11-10');
  assert.deepEqual(s.map((d) => [d.day, d.uploadedBytes, d.uploadedCount]), [
    ['2026-11-08', 0, 0], ['2026-11-09', 100, 2], ['2026-11-10', 0, 0],
  ]);
});

test('virada de mês', () => {
  assert.deepEqual(preencherDias([], 2, '2026-12-01').map((d) => d.day), ['2026-11-30', '2026-12-01']);
});
