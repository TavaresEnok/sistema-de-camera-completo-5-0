import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

test('gravação manual não altera a política contínua nem agenda parada automática', async () => {
  const manager: any = Object.create(RecordingProcessManagerService.prototype);
  manager.prisma = { camera: { findUnique: async () => ({ recordingMode: 'continuous' }) } };
  manager.start = async (_id: string, _segment: number, options: unknown) => ({ status: 'already_recording', options });
  manager.stop = async () => { throw new Error('não pode parar gravação contínua'); };

  const start = await manager.startManualRecording('cam-1', 300);
  assert.deepEqual(start.options, { recordingMode: 'continuous' });
  assert.equal(manager.manualStopTimers?.size ?? 0, 0);

  const stop = await manager.stopManualRecording('cam-1');
  assert.equal(stop.status, 'continuous_recording_protected');
});
