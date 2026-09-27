import test from 'node:test';
import assert from 'node:assert/strict';
import { streamUrlsCache as cache } from '../src/lib/stream-urls-cache.ts';

test('resposta invalidada não sobrescreve cache nem remove nova requisição em voo', async () => {
  cache.clearAll();
  let oldResolve!: (value: string) => void;
  let newResolve!: (value: string) => void;
  const old = cache.getOrFetch('camera', () => new Promise<string>(resolve => { oldResolve = resolve; }));
  cache.clear('camera');
  const fresh = cache.getOrFetch('camera', () => new Promise<string>(resolve => { newResolve = resolve; }));
  oldResolve('old');
  await old;
  assert.equal(cache.get('camera'), null);
  const shared = cache.getOrFetch('camera', async () => { throw Error('duplicou a requisição'); });
  newResolve('fresh');
  assert.deepEqual(await Promise.all([fresh, shared]), ['fresh', 'fresh']);
  assert.equal(cache.get('camera'), 'fresh');
  cache.clearAll();
});
