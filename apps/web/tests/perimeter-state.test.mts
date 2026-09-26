import test from 'node:test';
import assert from 'node:assert/strict';
import { perimeterState, crossingArrow } from '../src/lib/perimeter-state.ts';
import { testTrajectory, describePerimeterPosition } from '../src/lib/perimeter-test.ts';

test('monitorando exige captura recente e inferência confirmada para linhas', () => {
  const now = 100000;
  const healthy = { running: true, last_seen: 99, readiness: { ready: true }, inference: { status: 'ok' } };
  assert.equal(perimeterState(true, true, healthy, true, now).label, 'Análise ativa');
  assert.equal(perimeterState(true, true, undefined, true, now).attention, true);
  assert.equal(perimeterState(true, true, { ...healthy, inference: undefined }, true, now).attention, true);
  assert.equal(perimeterState(true, false, { ...healthy, last_seen: 60 }, true, now).attention, true);
  assert.notEqual(perimeterState(true, true, healthy, false, now).label, 'Monitorando');
  assert.equal(perimeterState(false, true, healthy, true, now).label, 'Câmera desconectada');
});
test('o teste explica movimento simulado e objeto ignorado sem confundir com alarme real', () => {
  const ignored = { id: 'i', name: 'Rua', kind: 'exclude', points: [[0, 0], [1, 0], [1, 1], [0, 1]] };
  assert.equal(describePerimeterPosition(null, [0.5, 0.5], [ignored], 'simulação'), 'Movimento simulado ignorado em Rua');
  assert.equal(describePerimeterPosition(null, [0.5, 0.5], [ignored], 'objeto'), 'Objeto ignorado em Rua');
});
test('seta atravessa a linha do lado negativo para positivo', () => {
  const arrow = crossingArrow([[0, 0.5], [1, 0.5]])!;
  assert.equal(arrow.x1, arrow.x2);
  assert.ok(arrow.y1 < 50 && arrow.y2 > 50);
  assert.equal(crossingArrow([[0, 0], [0, 0]]), null);
});
test('teste respeita direção, extensão do segmento e áreas ignoradas', () => {
  const line = { id: '1', name: 'Portão', kind: 'line', points: [[0.2, 0.5], [0.8, 0.5]], sentido: 'ab' };
  assert.deepEqual(testTrajectory([0.5, 0.3], [0.5, 0.7], [line]), ['Portão']);
  assert.deepEqual(testTrajectory([0.5, 0.7], [0.5, 0.3], [line]), []);
  assert.deepEqual(testTrajectory([0.9, 0.3], [0.9, 0.7], [line]), []);
  assert.deepEqual(testTrajectory([0.4, 0.5], [0.6, 0.5], [line]), []);
  assert.deepEqual(testTrajectory([0.5, 0.3], [0.5, 0.7], [line, { id: '2', name: 'Rua', kind: 'exclude', points: [[0, 0], [1, 0], [1, 1], [0, 1]] }]), []);
  assert.deepEqual(testTrajectory([0.1, 0.3], [0.5, 0.7], [line, { id: '3', name: 'Pátio', kind: 'include', points: [[0.2, 0], [0.8, 0], [0.8, 1], [0.2, 1]] }]), []);
});

test('entrar em área monitorada não finge ser evento de intrusão', () => {
  const area = { id: 'a', name: 'Pátio', kind: 'include', points: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]] };
  assert.deepEqual(testTrajectory([0.1, 0.5], [0.5, 0.5], [area]), []);
});
