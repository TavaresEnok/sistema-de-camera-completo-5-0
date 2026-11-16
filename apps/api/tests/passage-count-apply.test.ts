import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CamerasController } from '../src/cameras/cameras.controller';
import { AiService } from '../src/ai/ai.service';

test('changing only counting FPS restarts analysis and reports application status', async () => {
  const calls: string[] = [];
  const controller = Object.create(CamerasController.prototype) as any;
  Object.assign(controller, {
    accessControlService: { assertCanAdminCamera: async () => {} },
    commercialPolicy: { assertRetentionQuota: async () => {} },
    camerasService: { getCameraOrThrow: async () => ({ enabled: true }), update: async () => ({ id: 'test-camera', countingFps: 12 }) },
    auditService: { log: async () => {} },
    moduleRef: { get: (service: unknown) => service === AiService
      ? { stopAnalysis: async () => { calls.push('stop'); } }
      : { startCamera: async () => { calls.push('start'); return { status: 'started' }; } } },
  });
  const result = await controller.update({ id: 'test-user', role: 'ADMIN' }, 'test-camera', { countingFps: 12 }, {});
  assert.deepEqual(calls, ['stop', 'start']);
  assert.equal(result.aiApplyStatus, 'started');
  assert.equal(result.countingFps, 12);
});
