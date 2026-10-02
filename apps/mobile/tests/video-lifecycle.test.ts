import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

test('native video releases its effect when app goes to background', () => {
  const source = readFileSync(new URL('../src/components/WebRtcVideo.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(!foreground\)/);
  assert.match(source, /\[sessionIdentity, foreground\]/);
  assert.match(source, /pc\.close\(\)/);
  assert.match(source, /setTimeout\(\(\) => controller\.abort\(\), 3000\)/);
  // Assign the session only after validating the origin: cleanup carries auth.
  assert.ok(source.indexOf('resolved.origin !== original.origin') < source.indexOf('sessionUrl = resolved.toString()'));
  assert.doesNotMatch(source, /sessionUrl = response\.headers/);
});

test('H265 connection timeout is suspended in background', () => {
  const source = readFileSync(new URL('../src/components/HevcWebRtcVideo.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(!active \|\| status === 'live'\) return/);
  assert.match(source, /\[identity, reload, status, active\]/);
});
