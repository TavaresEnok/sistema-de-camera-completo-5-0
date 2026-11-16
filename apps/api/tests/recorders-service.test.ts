import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RecordersService } from '../src/recorders/recorders.service';

function fixture() {
  process.env.RECORDERS_ENABLED = 'true';
  const row = { id: 'recorder', name: 'Loja', manufacturer: 'intelbras', ip: '192.168.1.20', rtspPort: 554, httpPort: 80, onvifPort: null, username: 'operator', passwordEncrypted: 'secret', groupId: 'group' };
  const stored: any[] = []; const calls: any[] = [];
  const group = { id: 'group', isActive: true, accessStatus: 'ACTIVE', retentionDays: 3 };
  const db = { recorder: { findUnique: async () => row }, cameraGroup: { findUnique: async () => group }, camera: {
    findUnique: async ({ where }: any) => where.recorderId_channel ? stored.find(c => c.channel === where.recorderId_channel.channel) ?? null : stored.find(c => c.id === where.id),
    findFirst: async () => null,
    findMany: async () => stored,
  } };
  const cameraService = { create: async (dto: any, _privacy: any, recorderId: string) => {
    calls.push(dto); if (dto.channel === 3) throw new BadRequestException('Vídeo não confirmado.');
    const camera = { ...dto, id: `camera-${dto.channel}`, recorderId }; stored.push(camera); return camera;
  } };
  const policy = { assertFeature: async () => {}, assertRetentionQuota: async () => {}, assertCameraQuota: async () => { if (stored.length >= 2) throw new BadRequestException('Limite atingido.'); } };
  const service = new RecordersService(db as any, { decrypt: (s: string) => s } as any, cameraService as any, policy as any, { log: async () => {} } as any);
  return { service, row, stored, calls, group };
}
const actor = { id: 'admin', role: 'ADMIN' } as any;
const req = {} as any;
const channel = (n: number) => ({ channel: n, name: `Canal ${n}` });

test('import is idempotent and new channels start manual with IA and notices off', async () => {
  const f = fixture();
  const first = await f.service.import('recorder', { channels: [channel(1), channel(1), channel(2)] }, actor, req);
  assert.deepEqual(first.results.map(r => r.status), ['created', 'created']);
  const second = await f.service.import('recorder', { channels: [channel(1), channel(2)] }, actor, req);
  assert.deepEqual(second.results.map(r => r.status), ['existing', 'existing']);
  assert.equal(f.stored.length, 2);
  for (const call of f.calls) {
    assert.equal(call.recordingMode, 'manual'); assert.equal(call.recordingEnabled, false);
    assert.equal(call.aiEnabled, false); assert.equal(call.objectNoticeEnabled, false);
    assert.equal(call.retentionDays, 3); assert.equal(call.groupId, 'group');
  }
});
test('failure on one channel does not duplicate or hide successful imports, and quota is enforced per channel', async () => {
  const f = fixture();
  const result = await f.service.import('recorder', { channels: [channel(3), channel(1), channel(2), channel(4)] }, actor, req);
  assert.deepEqual(result.results.map(r => r.status), ['error', 'created', 'created', 'error']);
  assert.equal(f.calls.length, 3); assert.equal(f.stored.length, 2);
});
test('a suspended group cannot import channels', async () => {
  const f = fixture(); f.group.accessStatus = 'SUSPENDED';
  await assert.rejects(f.service.import('recorder', { channels: [channel(1)] }, actor, req), /inativo ou suspenso/);
  assert.equal(f.calls.length, 0);
});
test('flag disabled rejects backend operations even with a direct route', async () => {
  const f = fixture(); process.env.RECORDERS_ENABLED = 'false';
  await assert.rejects(f.service.detail('recorder'), /indisponível/);
  await assert.rejects(f.service.import('recorder', { channels: [channel(1)] }, actor, req), /indisponível/);
  assert.equal(f.calls.length, 0);
});
test('connection changes with active channels are rejected before data is changed', async () => {
  const f = fixture(); f.stored.push({ id: 'camera-1', enabled: true });
  await assert.rejects(f.service.update('recorder', { ...f.row, ip: '192.168.1.21', onvifPort: undefined, password: '' } as any, actor, req), /Desative os canais/);
  assert.equal(f.row.ip, '192.168.1.20');
});
