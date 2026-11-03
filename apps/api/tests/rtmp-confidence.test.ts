import assert from 'node:assert/strict';
import test from 'node:test';
import { CamerasService } from '../src/cameras/cameras.service';

test('RTMP creation stores the chosen AI confidence and preserves manual/disarmed recording', async () => {
  for (const confidence of [undefined, 55, 83, 90]) {
    let created: any;
    const service = Object.assign(Object.create(CamerasService.prototype), {
      validateReferences: async () => undefined,
      cryptoService: { encrypt: () => 'test-encrypted' },
      prisma: { camera: { create: async ({ data }: any) => { created = data; return { ...data, id: 'test-camera' }; } } },
      getDefaultRetentionDays: () => 3,
      buildIngestDescriptor: () => ({ serverUrl: 'rtmp://example.invalid', streamKey: 'test-only' }),
      logger: { log() {} },
    });
    await service.createPushSourcedCamera({ name: 'Test', aiConfidence: confidence, recordingMode: 'continuous', recordingEnabled: true });
    assert.equal(created.aiConfidence, confidence ?? 70);
    assert.equal(created.aiSensitivity, 'balanced');
    assert.equal(created.recordingMode, 'manual');
    assert.equal(created.recordingEnabled, false);
  }
});
