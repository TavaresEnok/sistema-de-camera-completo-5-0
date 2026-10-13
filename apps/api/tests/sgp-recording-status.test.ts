import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

test('suspended camera preserves recording policy without reporting a stopped process as recording', async () => {
  const service: any = Object.create(RecordingProcessManagerService.prototype);
  let query = 0;
  service.prisma = {
    camera: { findMany: async () => [{ id: 'camera', enabled: false, recordingEnabled: true }] },
    $queryRaw: async () => query++ === 0 ? [{ cameraId: 'camera', startedAt: new Date(), endedAt: new Date(), filePath: '/fixture.mp4' }] : [],
  };
  service.controlMode = 'local';
  service.active = new Map();
  service.manualStopTimers = new Map();
  service.safeRecordingWriteProgress = () => ({ applicable: false, stalled: false });
  service.getRecordingStaleThresholdSeconds = () => 120;
  const status = await service.getStatus('camera');
  assert.equal(status.hasRecentSegment, true);
  assert.equal(status.isRecording, false);
  assert.equal(status.intendedRecording, false);
  assert.equal(status.stale, false);
  assert.equal(status.statusDetail, 'disabled');
});

test('reactivation does not rewrite settings when its recording is already running', async () => {
  const service: any = Object.create(RecordingProcessManagerService.prototype);
  service.prisma = { camera: { findUniqueOrThrow: async () => ({ enabled: true, recordingMode: 'continuous', recordingEnabled: true }) } };
  service.active = new Map([['camera', { pid: process.pid }]]);
  service.start = () => assert.fail('An already active recording must not be started or rewritten');
  await service.resumeForIntegration('camera');
});
