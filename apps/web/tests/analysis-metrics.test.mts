import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisMetrics, formatAnalysisRate } from '../src/lib/analysis-metrics.ts';

test('separa IA real de acompanhamento sem inventar medições ausentes', () => {
  const m = analysisMetrics({ stream: { capture_fps: 20, motion_fps: 7, analysis_completion_age_ms: 45, superseded_frames: 18 }, performance: { object_model_frame_fps: 2, visual_track_fps: 5, object_busy_calls: 0 } });
  assert.deepEqual(m, { received: 20, motion: 7, model: 2, tracked: 5, delay: 45, replaced: 18, busy: 0 });
  assert.equal(analysisMetrics({}).delay, null);
  assert.equal(analysisMetrics({ stream: { capture_fps: Infinity } }).received, null);
  assert.equal(formatAnalysisRate(null), '—');
  assert.equal(formatAnalysisRate(0), '0/s');
});
