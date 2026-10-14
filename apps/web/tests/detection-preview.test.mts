import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DetectionActivityTimeline, hasFreshDetection } from '../src/lib/detection-activity.ts';
const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
test('highlight expires, refreshes only the affected camera and keeps repeated updates quiet', () => {
  const activity = new DetectionActivityTimeline();
  assert.equal(activity.mark('one', 0), true);
  assert.equal(activity.mark('two', 1000), true);
  assert.equal(activity.mark('one', 2000), false);
  assert.deepEqual(activity.expire(5999), []);
  assert.deepEqual(activity.expire(6000), ['two']);
  assert.deepEqual(activity.expire(7000), ['one']);
  assert.equal(activity.size, 0);
  activity.mark('one'); activity.clear(); assert.equal(activity.size, 0);
});
test('only fresh motion and object detections highlight the tile', () => {
  const now = 10_000;
  const event = { type: 'MOTION_DETECTED', occurredAt: new Date(now).toISOString() };
  assert.equal(hasFreshDetection([event], now), true);
  assert.equal(hasFreshDetection([{ ...event, type: 'OBJECT_DETECTED' }], now), true);
  for (const item of [{ ...event, type: 'CAMERA_OFFLINE' }, { ...event, occurredAt: 'invalid' }, { ...event, occurredAt: new Date(0).toISOString() }, { ...event, expiresAtMs: now - 1 }]) assert.equal(hasFreshDetection([item], now), false);
});
test('preview opens only on click, stays on the page, starts muted and respects access', () => {
  const popup = source('../src/components/MotionNotices.tsx');
  assert.match(popup, /onClick=\{\(\) => setPreview\(notice\)\}/);
  assert.match(popup, /key=\{preview.cameraId\}/);
  assert.match(popup, /liveViewMode="selected" muted showAudioControl/);
  assert.match(popup, /previewCamera.canViewContent !== false/);
  assert.match(popup, /setPreview\(null\)/);
  assert.match(popup, /reset\(\); \}, \[userId\]/);
  assert.match(popup, /portalContainer=\{portal\}/);
  assert.match(popup, /if \(!ownFullscreen\) setPortal/);
  assert.match(popup, /requestFullscreen/);
  assert.doesNotMatch(popup, /useNavigate|window.open|window.location|navigate\(/);
});
test('grid border shares existing detection polling and never changes camera settings', () => {
  const tile = source('../src/components/CameraTile.tsx');
  assert.match(tile, /liveDetectionsPoller.subscribe/);
  assert.match(tile, /data-detection-highlight="true"/);
  assert.match(tile, /pointer-events-none absolute inset-0 z-50 rounded-sm border-2 border-red-500/);
  assert.match(tile, /contentLocked \|\| !routeActive \|\| !playbackEnabled/);
  assert.doesNotMatch(tile, /setInterval\(|axios\.|fetch\(/);
  const store = source('../src/store/detectionActivityStore.ts');
  assert.match(store, /if \(!timeline.size\)/);
  assert.doesNotMatch(store, /persist\(|localStorage|axios|fetch\(/);
});
