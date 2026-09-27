import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverWhepIceServers, parseWhepIceServers } from '../src/lib/whep-ice-servers.ts';

test('WHEP transforma Link TURN do MediaMTX em RTCIceServer', () => {
  assert.deepEqual(parseWhepIceServers(
    '<turn:177.104.156.25:3478?transport=udp>; rel="ice-server"; username="1720000000:abc"; credential="segredo+/="; credential-type="password"',
  ), [{
    urls: 'turn:177.104.156.25:3478?transport=udp',
    username: '1720000000:abc',
    credential: 'segredo+/=',
  }]);
});

test('OPTIONS travado é abortado no prazo e não impede fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (_input, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  });
  try {
    const result = discoverWhepIceServers('https://site.test/whep', null);
    t.mock.timers.tick(3000);
    assert.deepEqual(await result, []);
    assert.equal(aborted, true);
  } finally { globalThis.fetch = original; t.mock.timers.reset(); }
});

test('WHEP aceita vários Links, ignora relações e esquemas que não são ICE', () => {
  const parsed = parseWhepIceServers([
    '<https://exemplo.test/politica>; rel="alternate"',
    '<stun:stun.exemplo.test:3478>; rel="ice-server"',
    '<turns:turn.exemplo.test:5349?transport=tcp>; rel="ice-server"; username="u"; credential="a,b"',
    '<javascript:alert(1)>; rel="ice-server"',
  ].join(', '));
  assert.deepEqual(parsed, [
    { urls: 'stun:stun.exemplo.test:3478' },
    { urls: 'turns:turn.exemplo.test:5349?transport=tcp', username: 'u', credential: 'a,b' },
  ]);
});

test('WHEP elimina servidor ICE duplicado e trata cabeçalho ausente', () => {
  const link = '<turn:turn.test:3478>; rel="ice-server"; username=x; credential=y';
  assert.equal(parseWhepIceServers(`${link}, ${link}`).length, 1);
  assert.deepEqual(parseWhepIceServers(null), []);
});
