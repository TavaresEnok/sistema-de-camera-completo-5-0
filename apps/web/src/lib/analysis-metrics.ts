// These are local analysis measurements, not camera-to-screen latency.
export function analysisMetrics(processor: any) {
  const stream = processor?.stream ?? {};
  const performance = processor?.performance ?? {};
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    received: number(stream.capture_fps),
    motion: number(stream.motion_fps),
    model: number(performance.object_model_frame_fps),
    tracked: number(performance.visual_track_fps),
    delay: number(stream.analysis_completion_age_ms),
    replaced: number(stream.superseded_frames),
    busy: number(performance.object_busy_calls),
  };
}

export function formatAnalysisRate(value: number | null) {
  return value === null ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}/s`;
}
