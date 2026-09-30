import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';
import { LiveCapacityBudget, LiveCapacityException, liveCapacityDefaults } from '../src/camera-stream/helpers/live-capacity.helper';

// ─────────────────────────────────────────────────────────────────────────────
// FREIO DE TRANSCODES SIMULTÂNEOS
//
// Medido na simulação de capacidade (2026-08-03), máquina de 15 núcleos:
//   H.264 passthrough ....... 1,3% de CPU por câmera
//   H.265 → transcode ....... 6,6% de CPU por câmera  (5× mais)
//
// Sem freio, um mural com 200 câmeras H.265 dispara 200 FFmpeg. O servidor não
// recusa: aceita todos e entrega os 200 travando — e como o transcode fica mais
// lento que o tempo real, TODAS degradam juntas, inclusive as que já estavam
// boas. Degradar previsivelmente é melhor que colapsar.
//
// A assimetria que importa: quem JÁ está no ar não é derrubado por um
// recém-chegado. Sem ela o freio vira um revezamento onde ninguém vê nada.
// ─────────────────────────────────────────────────────────────────────────────

function makeProxy(overrides: Record<string, unknown> = {}) {
  const config = { get: () => undefined } as any;
  const mgr = new MediamtxProxyService(config, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  Object.assign(mgr, overrides);
  return mgr;
}

test('os tetos padrão consideram afinidade e quota de CPU', () => {
  const mgr = makeProxy();
  const defaults = liveCapacityDefaults();
  assert.equal(mgr.maxTranscodes, defaults.processes,
    'o teto de processos precisa acompanhar o tamanho da máquina');
  assert.equal(mgr.maxTranscodePoints, defaults.points,
    'o orçamento ponderado precisa acompanhar o tamanho da máquina');
});

test('grade HEVC tem path próprio para coexistir com a contingência H.264', () => {
  const mgr = makeProxy();
  const cameraId = '12345678-1234-1234-1234-123456789abc';
  assert.equal(mgr.pathNameFromCameraId(cameraId, 'grid'), 'cam_12345678123412341234123456789abc_grid');
  assert.equal(mgr.pathNameFromCameraId(cameraId, 'grid-hevc'), 'cam_12345678123412341234123456789abc_grid_hevc');
});

test('o watchdog conta só os paths que REALMENTE transcodificam', () => {
  const mgr = makeProxy({
    isEnabled: () => true,
    reconcileMissingPaths: async () => undefined,
    apiRequest: async () => JSON.stringify({ items: [
      { name: 'cam_a_grid', ready: true,  source: { type: 'publisher' } },   // transcode
      { name: 'cam_b_grid', ready: true,  source: { type: 'rtspSource' } }, // passthrough
      { name: 'cam_c_grid', ready: false, source: { type: 'publisher' } },   // não pronto
      { name: 'cam_d_grid', ready: true,  source: { type: 'rtspSession' } }, // MediaMTX 1.18
    ]}),
    recoverStuckPaths: async () => undefined,
    reapDuplicateWebrtcSessions: async () => undefined,
    noteGenericTrack: () => undefined,
  });
  return mgr.streamWatchdogTick().then(() => {
    assert.equal(mgr.activeTranscodes, 2,
      'passthrough e path não-pronto não custam CPU de transcode e não podem entrar na conta');
  });
});

test('abaixo do teto, nada é recusado', () => {
  const mgr = makeProxy();
  mgr.activeTranscodes = 5;
  mgr.maxTranscodes = 10;
  assert.ok(mgr.activeTranscodes < mgr.maxTranscodes, 'o freio não deve agir com folga disponível');
});

test('o teto é configurável e tem limite superior', () => {
  const fonte = require('fs').readFileSync('src/camera-stream/mediamtx-proxy.service.ts', 'utf8');
  assert.ok(fonte.includes("envNumber(\n    'MEDIAMTX_MAX_CONCURRENT_TRANSCODES'")
         || fonte.includes("'MEDIAMTX_MAX_CONCURRENT_TRANSCODES'"),
    'o teto precisa ser ajustável por instalação');
  assert.ok(/max: 2000/.test(fonte), 'um teto sem limite superior não é freio');
});

test('quem JÁ tem path no ar não é derrubado pelo freio', () => {
  const budget = new LiveCapacityBudget();
  assert.doesNotThrow(() => budget.reserve('cam_a_grid', 4,
    [{ name: 'cam_a_grid', ready: true, source: { type: 'rtspSession' } }],
    { processes: 1, points: 1 }, { cpuPercent: 100, availableMemory: 0, totalMemory: 1 }));
});

test('a recusa explica o que fazer, não só que falhou', () => {
  const error = new LiveCapacityException();
  assert.equal(error.getStatus(), 503);
  assert.match((error.getResponse() as any).userMessage, /Feche algumas câmeras/);
});
