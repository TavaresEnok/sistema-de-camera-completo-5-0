import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverLegacyLayoutData } from '../src/lib/recover-legacy-layouts.ts';

test('recuperação mantém apenas câmeras permitidas, respeitando tamanho da grade', () => {
  const result = recoverLegacyLayoutData(JSON.stringify([{ name: ' Antigo ', gridSize: '1x2', cameraIds: ['allowed', 'private', 'extra'] }]), new Set(['allowed']));
  assert.deepEqual(result, [{ name: 'Antigo', gridSize: '1x2', cameraIds: ['allowed', ''] }]);
});
test('recuperação rejeita formato inválido e descarta entradas corrompidas', () => {
  assert.throws(() => recoverLegacyLayoutData('{}', new Set()));
  assert.throws(() => recoverLegacyLayoutData('broken', new Set()));
  assert.deepEqual(recoverLegacyLayoutData('[null,3,{"name":"","gridSize":"9x9","cameraIds":[]}]', new Set()), []);
});
test('recuperação limita volume e não copia campos privilegiados do cache', () => {
  const result = recoverLegacyLayoutData(JSON.stringify(Array.from({ length: 120 }, () => ({ name: 'x'.repeat(100), gridSize: '1x1', cameraIds: [], createdBy: 'other', podeEditar: false }))), new Set());
  assert.equal(result.length, 100);
  assert.equal(result[0].name.length, 80);
  assert.equal('createdBy' in result[0], false);
});
