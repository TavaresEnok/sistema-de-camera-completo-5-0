import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { haQuantoTempo, pontosDoEnvio, envioAtrasado } from '../src/lib/uso-da-nuvem.ts';

const AGORA = Date.parse('2026-11-10T21:00:00Z');

test('tempo desde o último envio em linguagem simples', () => {
  assert.equal(haQuantoTempo(null, AGORA), null);
  assert.equal(haQuantoTempo('2026-11-10T20:57:00Z', AGORA), 'há 3 min');
  assert.equal(haQuantoTempo('2026-11-10T19:00:00Z', AGORA), 'há 2 h');
  assert.equal(haQuantoTempo('2026-11-09T21:00:00Z', AGORA), 'há 1 dia');
});

test('pontos do gráfico em GB com rótulo dd/mm', () => {
  const [p] = pontosDoEnvio([{ day: '2026-11-10', uploadedBytes: 2 * 1024 ** 3, uploadedCount: 7 }]);
  assert.deepEqual(p, { rotulo: '10/11', gb: 2, gravacoes: 7 });
});

test('atraso só quando há pendência e nada subiu na última hora', () => {
  assert.equal(envioAtrasado({ pendingCount: 0, lastUploadAt: null }, AGORA), false);
  assert.equal(envioAtrasado({ pendingCount: 5, lastUploadAt: '2026-11-10T20:50:00Z' }, AGORA), false);
  assert.equal(envioAtrasado({ pendingCount: 5, lastUploadAt: '2026-11-10T19:00:00Z' }, AGORA), true);
});

test('página de armazenamento mostra a nuvem no topo e o painel de uso', () => {
  assert.match(readFileSync('src/pages/StoragePage.tsx', 'utf8'), /Na nuvem/);
  assert.match(readFileSync('src/components/CloudStorageCard.tsx', 'utf8'), /<UsoDaNuvem /);
});
