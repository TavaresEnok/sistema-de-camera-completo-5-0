import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

test('gravação manual não altera a política contínua nem agenda parada automática', async () => {
  const manager: any = Object.create(RecordingProcessManagerService.prototype);
  manager.manualStopTimers = new Map();
  manager.prisma = { camera: { findUnique: async () => ({ recordingMode: 'continuous' }) } };
  manager.start = async () => { throw new Error('não pode alterar gravação contínua'); };
  manager.stop = async () => { throw new Error('não pode parar gravação contínua'); };

  const start = await manager.startManualRecording('cam-1', 300);
  assert.equal(start.status, 'continuous_recording_protected');
  assert.equal(manager.manualStopTimers?.size ?? 0, 0);

  const stop = await manager.stopManualRecording('cam-1');
  assert.equal(stop.status, 'continuous_recording_protected');
});

test('dois comandos simultâneos são serializados e deixam somente um timer', async () => {
  const manager: any = Object.create(RecordingProcessManagerService.prototype);
  manager.manualStopTimers = new Map();
  manager.motionStopTimers = new Map();
  manager.prisma = { camera: { findUnique: async () => ({ recordingMode: 'motion' }) } };
  let active = 0;
  let peak = 0;
  manager.start = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { status: 'recording_started' };
  };
  manager.stop = async () => ({ status: 'stopped' });
  await Promise.all([manager.startManualRecording('c', 60), manager.startManualRecording('c', 60)]);
  assert.equal(peak, 1);
  assert.equal(manager.manualStopTimers.size, 1);
  await manager.stopManualRecording('c');
  assert.equal(manager.manualStopTimers.size, 0);
});

test('fim de movimento não encerra uma gravação manual vigente', async () => {
  const manager: any = Object.create(RecordingProcessManagerService.prototype);
  manager.manualStopTimers = new Map([['c', true]]);
  manager.motionStopTimers = new Map();
  manager.stop = async () => { throw new Error('não pode parar'); };
  await manager.stopMotionRecordingAfterQuiet('c', 60);
});
