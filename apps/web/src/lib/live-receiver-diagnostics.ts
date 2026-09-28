/** Counters only: never export candidate addresses, SDP, tokens or URLs. */
export function summarizeVideoReceiver(stats: { forEach: (fn: (report: any) => void) => void }) {
  const result = { framesReceived: 0, framesDecoded: 0, framesDropped: 0,
    packetsLost: 0, jitterSeconds: 0, jitterBufferDelaySeconds: 0,
    jitterBufferEmittedCount: 0, totalDecodeTimeSeconds: 0, freezeCount: 0,
    rttSeconds: null as number | null, relay: false };
  const reports = new Map<string, any>();
  const count = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  stats.forEach(report => {
    reports.set(report.id, report);
    if (report.type !== 'inbound-rtp' || (report.kind ?? report.mediaType) !== 'video' || report.isRemote) return;
    result.framesReceived += count(report.framesReceived);
    result.framesDecoded += count(report.framesDecoded);
    result.framesDropped += count(report.framesDropped);
    result.packetsLost += count(report.packetsLost);
    result.jitterSeconds = Math.max(result.jitterSeconds, count(report.jitter));
    result.jitterBufferDelaySeconds += count(report.jitterBufferDelay);
    result.jitterBufferEmittedCount += count(report.jitterBufferEmittedCount);
    result.totalDecodeTimeSeconds += count(report.totalDecodeTime);
    result.freezeCount += count(report.freezeCount);
  });
  for (const report of reports.values()) {
    if (report.type !== 'transport' || !report.selectedCandidatePairId) continue;
    const pair = reports.get(report.selectedCandidatePairId);
    if (!pair) continue;
    result.rttSeconds = Number.isFinite(pair.currentRoundTripTime) ? pair.currentRoundTripTime : null;
    result.relay = [pair.localCandidateId, pair.remoteCandidateId]
      .some(id => reports.get(id)?.candidateType === 'relay');
  }
  return result;
}
