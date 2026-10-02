import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liveDecoderInputArgs } from '../src/camera-stream/helpers/live-decoder-budget.helper';

test('decoder threads are bounded separately from the encoder', () => {
  assert.equal(liveDecoderInputArgs({}), '-threads 2');
  assert.equal(liveDecoderInputArgs({ LIVE_CAPTURE_DECODER_THREADS: '1' }), '-threads 1');
  assert.equal(liveDecoderInputArgs({ LIVE_CAPTURE_DECODER_THREADS: '0' }), '-threads 1');
  assert.equal(liveDecoderInputArgs({ LIVE_CAPTURE_DECODER_THREADS: '99' }), '-threads 16');
  assert.equal(liveDecoderInputArgs({ LIVE_CAPTURE_DECODER_THREADS: '4.9' }), '-threads 4');
  assert.equal(liveDecoderInputArgs({ LIVE_CAPTURE_DECODER_THREADS: '2; echo secret' }), '-threads 2');
});

test('the input limit precedes -i, and does not replace the encoder limit', () => {
  const src = readFileSync('src/camera-stream/mediamtx-proxy.service.ts', 'utf8');
  const start = src.indexOf('const buildFfmpegCommand');
  const block = src.slice(start, src.indexOf('const ffmpegCommand', start));
  assert.ok(block.indexOf('liveDecoderInputArgs()') < block.indexOf('-i "'));
  assert.match(src, /'-threads 2 -c:v libx264/);
});
