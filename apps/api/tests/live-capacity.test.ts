import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveCapacityBudget, LiveCapacityException, effectiveLiveCpus } from '../src/camera-stream/helpers/live-capacity.helper';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';
import { CameraStreamController } from '../src/camera-stream/camera-stream.controller';
import { withHostPressureAdmission } from '../src/camera-stream/helpers/transcode-admission.helper';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const room = { cpuPercent: 20, availableMemory: 8e9, totalMemory: 16e9 };

test('3 telas de 36 câmeras iguais compartilham 36 conversões, incluindo partidas simultâneas', async () => {
  const budget = new LiveCapacityBudget();
  const requests = Array.from({ length: 108 }, (_, i) => Promise.resolve().then(() =>
    budget.reserve(`cam_${i % 36}_grid`, 2, [], { processes: 36, points: 72 }, room, 1000)));
  await Promise.all(requests);
  assert.throws(() => budget.reserve('cam_nova_grid', 2, [], { processes: 36, points: 72 }, room, 1001), LiveCapacityException);
});

test('108 fontes diferentes respeitam o orçamento mesmo antes de a primeira publicar', async () => {
  const budget = new LiveCapacityBudget();
  const results = await Promise.allSettled(Array.from({ length: 108 }, (_, i) => Promise.resolve().then(() =>
    budget.reserve(`cam_${i}_grid`, 2, [], { processes: 108, points: 72 }, room, 1000))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 36);
  assert.equal(results.filter(r => r.status === 'rejected').length, 72);
});

test('CPU e memória reservam recursos para gravação, IA e banco sem bloquear cópia de vídeo', () => {
  for (const pressure of [{ ...room, cpuPercent: 80 }, { ...room, availableMemory: 1e8 }, { ...room, loadRatio: 0.8 }]) {
    const budget = new LiveCapacityBudget();
    assert.throws(() => budget.reserve('cam_a_grid', 2, [], { processes: 100, points: 100 }, pressure), LiveCapacityException);
    assert.doesNotThrow(() => budget.reserve('cam_b_grid', 0, [], { processes: 100, points: 100 }, pressure));
  }
});

test('guarda no processo de mídia recusa pressão mesmo quando o cliente reutiliza URL em cache', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'live-pressure-'));
  t.after(() => rmSync(root, { recursive: true }));
  const command = withHostPressureAdmission('true', 4);
  assert.doesNotMatch(command, /\$/, 'MediaMTX não pode consumir variáveis do awk');
  const encoded = /printf %s ([A-Za-z0-9+/=]+)/.exec(command)![1];
  const script = Buffer.from(encoded, 'base64').toString('utf8')
    .replace('/proc/loadavg', join(root, 'load'))
    .replace('/proc/meminfo', join(root, 'memory'));
  writeFileSync(join(root, 'load'), '1.00 1.00 1.00 1/100 123\n');
  writeFileSync(join(root, 'memory'), 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n');
  assert.equal(spawnSync('sh', ['-c', script]).status, 0);
  writeFileSync(join(root, 'load'), '3.5 1.00 1.00 1/100 123\n');
  assert.equal(spawnSync('sh', ['-c', script]).status, 75);
  writeFileSync(join(root, 'load'), '1.00 1.00 1.00 1/100 123\n');
  writeFileSync(join(root, 'memory'), 'MemTotal: 8000000 kB\nMemAvailable: 100000 kB\n');
  assert.equal(spawnSync('sh', ['-c', script]).status, 75);
});

test('reserva não é duplicada quando vira publisher e expira quando a aba não conecta', () => {
  const budget = new LiveCapacityBudget(), limits = { processes: 2, points: 4 };
  budget.register('cam_a_grid', 2);
  budget.reserve('cam_a_grid', 2, [], limits, room, 1000);
  const active = [{ name: 'cam_a_grid', ready: true, source: { type: 'rtspSession' } }];
  budget.reserve('cam_b_grid', 2, active, limits, room, 1001);
  assert.throws(() => budget.reserve('cam_c_grid', 2, active, limits, room, 1002), LiveCapacityException);
  assert.doesNotThrow(() => budget.reserve('cam_c_grid', 2, active, limits, room, 32_000));
});

test('quota de container nunca usa todos os núcleos do host por engano', () => {
  assert.equal(effectiveLiveCpus(32, '200000 100000'), 2);
  assert.equal(effectiveLiveCpus(4, 'max 100000'), 4);
  assert.equal(effectiveLiveCpus(2, '400000 100000'), 2);
  assert.equal(effectiveLiveCpus(32, '50000 100000'), 0.5);
});

test('a API propaga capacidade como 503 explícito para câmeras pull e push', async () => {
  for (const sourceMode of ['rtsp_pull', 'rtmp_push']) {
    const c = Object.create(CameraStreamController.prototype) as any;
    c.accessControlService = { assertCanViewCamera: async () => {} };
    c.commercialPolicy = { assertFeature: async () => {} };
    c.camerasService = { getCameraOrThrow: async () => ({ id: 'cam', sourceMode, detectedVideoCodec: 'h265', detectedWidth: 1920, detectedHeight: 1080 }) };
    c.authService = { createStreamToken: async () => 'test-token' };
    c.mediamtxProxyService = {
      buildPublicUrls: () => ({}), isEnabled: () => true, markGridViewed() {},
      ensurePathForCamera: async () => ({ pathName: 'cam_grid' }),
      assertDeliveryCapacity: async () => { throw new LiveCapacityException(); },
    };
    await assert.rejects(c.getDeliveryUrls({ id: 'user' }, 'cam', 'grid', {}), LiveCapacityException);
  }
});

test('ocupação inclui todas as páginas do MediaMTX, sem liberar vaga invisível após 1000 paths', async () => {
  const service = new MediamtxProxyService({ get: () => undefined } as any, {} as any, {} as any) as any;
  const calls: string[] = [];
  service.apiRequest = async (_: string, url: string) => {
    calls.push(url);
    return JSON.stringify({ pageCount: 2, items: [{ name: url.includes('page=1') ? 'cam_b_grid' : 'cam_a_grid' }] });
  };
  const [a, b] = await Promise.all([service.getRuntimePathItems(), service.getRuntimePathItems()]);
  assert.equal(a.length, 2);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 2);
});
