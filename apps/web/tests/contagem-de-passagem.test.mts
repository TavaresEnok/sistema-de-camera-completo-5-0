import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { periodoDaContagem, rotuloDoBalde, somarPorBalde, csvDaContagem } from '../src/lib/contagem-de-passagem.ts';
import { describePerimeterPosition, testTrajectory } from '../src/lib/perimeter-test.ts';

const AGORA = new Date('2026-11-10T18:30:00Z');

test('hoje começa à meia-noite e agrupa por hora; 7 dias agrupa por dia', () => {
  const hoje = periodoDaContagem('hoje', AGORA);
  assert.equal(hoje.groupBy, 'hour');
  assert.equal(hoje.from.toISOString(), '2026-11-10T03:00:00.000Z');
  const semana = periodoDaContagem('7d', AGORA);
  assert.equal(semana.groupBy, 'day');
  assert.equal(semana.from.toISOString(), '2026-11-04T03:00:00.000Z');
});

test('rótulos curtos', () => {
  assert.equal(rotuloDoBalde('2026-11-10T14:00', 'hour'), '14h');
  assert.equal(rotuloDoBalde('2026-11-10T00:00', 'day'), '10/11');
});

test('gráfico soma todas as linhas por balde, em ordem', () => {
  const pontos = somarPorBalde([
    { bucket: '2026-11-10T15:00', cameraId: 'c', lineId: 'a', lineName: 'A', in: 2, out: 1 },
    { bucket: '2026-11-10T14:00', cameraId: 'c', lineId: 'a', lineName: 'A', in: 5, out: 4 },
    { bucket: '2026-11-10T15:00', cameraId: 'd', lineId: 'b', lineName: 'B', in: 3, out: 0 },
  ], 'hour');
  assert.deepEqual(pontos.map((p) => [p.rotulo, p.in, p.out]), [['14h', 5, 4], ['15h', 5, 1]]);
});

test('gráfico mantém horas sem registros e ignora horas futuras', () => {
  const pontos = somarPorBalde([
    { bucket: '2026-11-10T01:00', cameraId: 'c', lineId: 'a', lineName: 'A', in: 2, out: 0 },
    { bucket: '2026-11-10T03:00', cameraId: 'c', lineId: 'a', lineName: 'A', in: 1, out: 0 },
  ], 'hour', { from: '2026-11-10T03:00:00Z', to: '2026-11-10T07:00:00Z' });
  assert.deepEqual(pontos.map(p => [p.rotulo, p.in]), [['00h', 0], ['01h', 2], ['02h', 0], ['03h', 1]]);
});

test('CSV com ponto e vírgula, BOM para o Excel, saídas opcionais', () => {
  const series = [{ bucket: '2026-11-10T14:00', cameraId: 'c', lineId: 'a', lineName: 'Porta; frente', in: 5, out: 4 }];
  const csv = csvDaContagem(series, [{ cameraId: 'c', cameraName: 'Loja 1', lineId: 'a' }], false);
  assert.ok(csv.startsWith('﻿Período;Câmera;Linha;Entradas\n'));
  assert.match(csv, /2026-11-10 14:00;Loja 1;"Porta; frente";5\n/);
  assert.match(csvDaContagem(series, [], true), /Saídas/);
});

test('Brazilian day boundary is independent of the browser timezone', () => {
  const old = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = timezone;
      const p = periodoDaContagem('hoje', new Date('2026-11-11T01:00:00Z'));
      assert.equal(p.from.toISOString(), '2026-11-10T03:00:00.000Z');
    }
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});

test('CSV does not execute camera or line names as Excel formulas', () => {
  const series = [{ bucket: '2026-11-10T14:00', cameraId: 'c', lineId: 'a', lineName: '=1+1', in: 5, out: 4 }];
  const csv = csvDaContagem(series, [{ cameraId: 'c', lineId: 'a', cameraName: '+SUM(1)' }], true);
  assert.ok(csv.includes(";'+SUM(1);'=1+1;5;4"));
});

test('simulação: linha de contagem mostra entrada ou saída em qualquer sentido', () => {
  const linha = { id: 'l', name: 'Porta', kind: 'line', points: [[0.5, 0.2], [0.5, 0.8]], uso: 'contagem', entrada: 'ab', sentido: 'ab' };
  const ida = testTrajectory([0.3, 0.5], [0.7, 0.5], [linha]);
  const volta = testTrajectory([0.7, 0.5], [0.3, 0.5], [linha]);
  assert.equal(ida.length, 1);
  assert.equal(volta.length, 1);
  assert.notEqual(ida[0], volta[0]);
  assert.ok([...ida, ...volta].some((n) => n.includes('entrada')));
  assert.ok([...ida, ...volta].some((n) => n.includes('saída')));
});

test('counting simulation accepts entry/exit at the boundary of an included area', () => {
  const line = { id: 'l', name: 'Door', kind: 'line', points: [[0.5, 0.2], [0.5, 0.8]], uso: 'contagem' };
  const area = { id: 'a', name: 'Store', kind: 'include', points: [[0.5, 0], [1, 0], [1, 1], [0.5, 1]] };
  assert.equal(testTrajectory([0.3, 0.5], [0.7, 0.5], [line, area]).length, 1);
  assert.equal(testTrajectory([0.7, 0.5], [0.3, 0.5], [line, area]).length, 1);
  assert.equal(describePerimeterPosition([0.7, 0.5], [0.3, 0.5], [line, area], 'simulação'), 'Travessia simulada em Door (entrada)');
  assert.equal(testTrajectory([0.3, 0.5], [0.7, 0.5], [line, { ...area, kind: 'exclude' }]).length, 0);
});

test('editor oferece uso Alerta/Contagem e sentido de entrada', () => {
  const fonte = readFileSync('src/components/DetectionZonesEditor.tsx', 'utf8');
  assert.match(fonte, /<option value="contagem">Contagem<\/option>/);
  assert.match(fonte, /Entrada A → B/);
  assert.match(fonte, /Qualquer sentido/);
});

test('link antigo da contagem redireciona e os alertas continuam restritos', () => {
  const fonte = readFileSync('src/App.tsx', 'utf8');
  assert.match(fonte, /get\('aba'\) === 'contagem'.*Redirect to="\/contagem"/);
  assert.match(fonte, /component=\{AlarmsPage\} minRole="operator"/);
});
