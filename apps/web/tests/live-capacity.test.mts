import test from 'node:test';
import assert from 'node:assert/strict';
import { liveCapacityWait } from '../src/lib/live-capacity.ts';

test('capacidade agenda nova tentativa espaçada e não expõe diagnóstico interno', () => {
  const body = { error: 'live_capacity_reached', userMessage: 'internal secret', retryAfterSeconds: -1 };
  const first = liveCapacityWait(503, body, 0)!;
  const last = liveCapacityWait(503, body, 1)!;
  assert.equal(first.delayMs, 30_000);
  assert.equal(last.delayMs, 40_000);
  assert.match(first.message, /Capacidade de visualização ocupada/);
  assert.doesNotMatch(first.message, /secret/);
});

test('falha de câmera, permissão ou API não vira diagnóstico falso de capacidade', () => {
  assert.equal(liveCapacityWait(503, { error: 'rtmp_source_unavailable' }), null);
  assert.equal(liveCapacityWait(403, { error: 'live_capacity_reached' }), null);
  assert.equal(liveCapacityWait(503, null), null);
});
