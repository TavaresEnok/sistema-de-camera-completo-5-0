import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeHlsUrl, prepareNativeHls } from '../src/lib/native-hls.ts';

test('HLS nativo recusa outra origem, caminho arbitrário e HTTP inseguro', () => {
  const page = 'https://site.test/live';
  assert.throws(() => nativeHlsUrl('https://other.test/hls/cam_a/index.m3u8', page));
  assert.throws(() => nativeHlsUrl('/api/admin', page));
  assert.throws(() => nativeHlsUrl('/hls/cam_a/index.m3u8', 'http://site.test/live'));
  assert.equal(nativeHlsUrl('/hls/cam_a/index.m3u8?token=old', page).search, '');
});

test('bootstrap usa cookie da mesma origem e devolve URL sem token para o vídeo', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input, options) => {
      assert.equal(new URL(String(input)).searchParams.get('token'), 'secret');
      assert.equal(options?.credentials, 'same-origin');
      assert.equal(options?.redirect, 'error');
      return new Response('#EXTM3U', { headers: { 'x-s2cam-hls-session': 'camera' } });
    };
    const url = await prepareNativeHls('/hls/cam_a/index.m3u8', 'secret', 'https://site.test/live', new AbortController().signal);
    assert.equal(url, 'https://site.test/hls/cam_a/index.m3u8');
  } finally { globalThis.fetch = original; }
});
