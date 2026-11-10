import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { periodoDaContagem, rotuloDoBalde, somarPorBalde, csvDaContagem } from '../src/lib/contagem-de-passagem.ts';
import { testTrajectory } from '../src/lib/perimeter-test.ts';

const AGORA = new Date(2026, 10, 10, 15, 30);

test('hoje começa à meia-noite e agrupa por hora; 7 dias agrupa por dia', () => {
  const hoje = periodoDaContagem('hoje', AGORA);
  assert.equal(hoje.groupBy, 'hour');
  assert.equal(hoje.from.getHours(), 0);
  const semana = periodoDaContagem('7d', AGORA);
  assert.equal(semana.groupBy, 'day');
  assert.equal(semana.from.getDate(), 4);
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

test('CSV com ponto e vírgula, BOM para o Excel, saídas opcionais', () => {
  const series = [{ bucket: '2026-11-10T14:00', cameraId: 'c', lineId: 'a', lineName: 'Porta; frente', in: 5, out: 4 }];
  const csv = csvDaContagem(series, [{ cameraId: 'c', cameraName: 'Loja 1', lineId: 'a' }], false);
  assert.ok(csv.startsWith('﻿Período;Câmera;Linha;Entradas\n'));
  assert.match(csv, /2026-11-10 14:00;Loja 1;"Porta; frente";5\n/);
  assert.match(csvDaContagem(series, [], true), /Saídas/);
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

test('editor oferece uso Alerta/Contagem e sentido de entrada', () => {
  const fonte = readFileSync('src/components/DetectionZonesEditor.tsx', 'utf8');
  assert.match(fonte, /<option value="contagem">Contagem<\/option>/);
  assert.match(fonte, /Entrada A → B/);
  assert.match(fonte, /Qualquer sentido/);
});

test('página de alarmes ganhou a aba Contagem sem perder os alertas', () => {
  const fonte = readFileSync('src/pages/AlarmsPage.tsx', 'utf8');
  assert.match(fonte, /ContagemDePassagem/);
  assert.match(fonte, /<AlertasPage \/>/);
});
