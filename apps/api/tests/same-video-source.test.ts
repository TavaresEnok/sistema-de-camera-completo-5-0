import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sameVideoSource } from '../src/camera-stream/helpers/same-video-source.helper';

test('sharing requires the same camera, credential, channel and subtype', () => {
  const source = 'rtsp://user:pass@camera.test/live?channel=1&subtype=0';
  assert.equal(sameVideoSource(source, source), true);
  for (const other of [null, '', 'invalid', source.replace('camera.test', 'other.test'),
    source.replace('pass@', 'changed@'), source.replace('channel=1', 'channel=2'),
    source.replace('subtype=0', 'subtype=1'), source.replace('rtsp:', 'https:')]) {
    assert.equal(sameVideoSource(source, other), false);
  }
});

test('AI checks physical source before using the shared grid', () => {
  const code = readFileSync('src/ai/ai-manager.service.ts', 'utf8');
  assert.match(code, /sameVideoSource\(rtspUrl, ensured.sourceUrl\)/);
  assert.match(code, /sharedUrl && sameVideoSource\(rtspUrl, shared.sourceUrl\)/);
});

test('audio delivery cannot overwrite the shared source registration', () => {
  const code = readFileSync('src/camera-stream/mediamtx-proxy.service.ts', 'utf8');
  assert.match(code, /if \(!deliveryMode.endsWith\('-audio'\)\) \{\s*this.sourceGateway\?\.registerPublishedSource/);
});
