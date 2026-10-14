import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamResourceAdvisorService } from '../src/camera-stream/stream-resource-advisor.service';
test('disabled recording is not a recording failure in the Central summary', async () => {
  const cameras = ['disabled', 'ok', 'attention'].map(state => ({ id: state }));
  const advisor = new StreamResourceAdvisorService({ findAllInternal: async () => cameras } as any, {} as any, {} as any);
  (advisor as any).buildCameraReport = async (camera: { id: string }) => ({
    status: 'ONLINE', resource: { findings: [], level: 'ok' }, mediaMtx: { readerCount: 0 },
    profiles: { live: { protocol: 'webrtc' }, analytics: {} }, playback: {},
    operations: { live: { failuresLast24h: 0 }, recording: { state: camera.id, segmentsLast24h: 0, gapSecondsLast24h: 0 } },
  });
  (advisor as any).buildSafeOptimizationPlan = () => ({});
  (advisor as any).aggregateRecommendations = () => [];
  const report = await advisor.getFleetReport();
  assert.equal(report.summary.camerasWithRecordingAttention, 1);
  assert.equal((await advisor.getFleetReport(['disabled'])).summary.camerasWithRecordingAttention, 0);
});
