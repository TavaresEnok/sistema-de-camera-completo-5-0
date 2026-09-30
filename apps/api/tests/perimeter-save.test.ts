import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { CamerasService } from '../src/cameras/cameras.service';

const area = {
  id: 'zone-1', name: 'Entrada', kind: 'include' as const,
  points: [[0.1, 0.1], [0.8, 0.1], [0.5, 0.8]],
};

function makeService(current: unknown) {
  let written: any = null;
  const camera = {
    id: 'cam-legacy', name: 'Câmera antiga', detectionZones: current,
    httpPort: null, onvifPort: null, recordingMode: 'motion', motionTrigger: 'CAMERA',
    site: null, area: null, group: null,
  };
  const tx = {
    camera: {
      findUnique: async () => camera,
      update: async ({ data }: any) => ({ ...camera, ...data, updatedAt: new Date() }),
    },
  };
  const service = Object.create(CamerasService.prototype) as any;
  service.prisma = {
    $transaction: async (operation: (client: any) => unknown) => operation(tx),
  };
  tx.camera.update = async ({ data }: any) => {
    written = data;
    return { ...camera, ...data, updatedAt: new Date() };
  };
  return { service, getWritten: () => written };
}

test('perímetro salva em câmera antiga sem exigir porta HTTP ou ONVIF', async () => {
  const { service, getWritten } = makeService(null);
  const result = await service.updateDetectionZones('cam-legacy', {
    expectedDetectionZones: [], detectionZones: [area],
  });
  assert.deepEqual(result.detectionZones, [area]);
  assert.equal(getWritten().motionTrigger, 'SYSTEM');
  assert.equal(getWritten().aiEnabled, true, 'área por movimento precisa armar o detector local');
});

test('health check não participa da concorrência; somente o desenho anterior é comparado', async () => {
  const { service } = makeService([area]);
  const next = { ...area, name: 'Portão' };
  await assert.doesNotReject(service.updateDetectionZones('cam-legacy', {
    expectedDetectionZones: [area], detectionZones: [next],
  }));
});

test('edição real do mesmo perímetro em outra sessão preserva o rascunho e responde conflito', async () => {
  const { service, getWritten } = makeService([{ ...area, name: 'Alterada por outra pessoa' }]);
  await assert.rejects(service.updateDetectionZones('cam-legacy', {
    expectedDetectionZones: [area], detectionZones: [{ ...area, name: 'Meu desenho' }],
  }), ConflictException);
  assert.equal(getWritten(), null);
});
