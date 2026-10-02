import test from 'node:test';
import assert from 'node:assert/strict';
import { nextLiveOverlayState } from '../src/lib/live-overlay-state.ts';
import type { LiveDetection } from '../src/lib/live-detections-poller.ts';

const detection = (changes: Partial<LiveDetection> = {}): LiveDetection => ({
  id: 'event-1', type: 'OBJECT_DETECTED', label: 'person', confidence: 0.9,
  similarity: null, bbox: [10, 20, 40, 70], frameWidth: 640, frameHeight: 360,
  occurredAt: '2026-10-02T00:00:00Z', trackId: 0, ...changes,
});

test('empty and invisible motion polls do not redraw the player', () => {
  const previous: LiveDetection[] = [];
  assert.equal(nextLiveOverlayState(previous, []), previous);
  assert.equal(nextLiveOverlayState(previous, [detection({ label: 'motion', type: 'MOTION_DETECTED' })]), previous);
});

test('an unchanged visible result preserves state identity', () => {
  const previous = [detection()];
  assert.equal(nextLiveOverlayState(previous, [detection({ ageMs: 500 })]), previous);
});

test('new samples and changed drawing properties still update immediately', () => {
  const previous = [detection()];
  for (const changes of [{ id: 'event-2' }, { bbox: [20, 20, 50, 70] as [number,number,number,number] },
    { confidence: 0.8 }, { overlayMode: 'triangle' }, { frameWidth: 1920 }, { stationary: true },
    { trackId: 1 }, { occurredAt: '2026-10-02T00:00:01Z' }]) {
    assert.notEqual(nextLiveOverlayState(previous, [detection(changes)]), previous);
  }
});

test('expired boxes disappear; objects alongside motion remain visible', () => {
  const previous = [detection()];
  assert.deepEqual(nextLiveOverlayState(previous, []), []);
  assert.equal(nextLiveOverlayState(previous, [detection(), detection({ label: 'motion' })]), previous);
});
