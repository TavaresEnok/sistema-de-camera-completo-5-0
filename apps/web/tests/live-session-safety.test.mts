import test from 'node:test';
import assert from 'node:assert/strict';
import { safeWhepSessionUrl, presentedFrameRate } from '../src/lib/live-session-safety.ts';
import { summarizeVideoReceiver } from '../src/lib/live-receiver-diagnostics.ts';

test('WHEP session may be relative but must not escape the media origin', () => {
  assert.equal(safeWhepSessionUrl('session/1', 'https://video.test/cam/whep'), 'https://video.test/cam/session/1');
  assert.equal(safeWhepSessionUrl(null, 'https://video.test/whep'), null);
  for (const location of ['https://evil.test/session', '//evil.test/session', 'http://video.test/session', 'https://user:pass@video.test/session']) {
    assert.throws(() => safeWhepSessionUrl(location, 'https://video.test/whep'));
  }
});

test('FPS uses presented frames, including frames skipped by JS callbacks', () => {
  assert.equal(presentedFrameRate(100, 140, 2000), 20);
  assert.equal(presentedFrameRate(140, 2, 1200), null);
  assert.equal(presentedFrameRate(0, 10, 0), null);
  assert.equal(presentedFrameRate(0, NaN, 1200), null);
});

test('receiver diagnostics separate video from audio and redact ICE addresses', () => {
  const reports = [
    { id: 'v', type: 'inbound-rtp', kind: 'video', framesDecoded: 40, packetsLost: 2 },
    { id: 'a', type: 'inbound-rtp', kind: 'audio', packetsLost: 100 },
    { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
    { id: 'p', type: 'candidate-pair', localCandidateId: 'c', currentRoundTripTime: .1 },
    { id: 'c', type: 'local-candidate', candidateType: 'relay', address: 'private-address' },
  ];
  const result = summarizeVideoReceiver(reports);
  assert.equal(result.packetsLost, 2);
  assert.equal(result.framesDecoded, 40);
  assert.equal(result.relay, true);
  assert.equal(result.rttSeconds, .1);
  assert.doesNotMatch(JSON.stringify(result), /private-address/);
});
