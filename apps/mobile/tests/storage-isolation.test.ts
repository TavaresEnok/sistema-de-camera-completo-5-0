import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCachedPosters, savePoster } from '../src/services/poster-cache';
import { addClip, listClips } from '../src/services/clips';

test('posters concorrentes preservam todas as entradas e escopos', async () => {
  await Promise.all([savePoster('account-A', 'one', 'https://a.invalid/1'), savePoster('account-A', 'two', 'https://a.invalid/2')]);
  assert.deepEqual(Object.keys((await loadCachedPosters('account-A', ['one', 'two'])).posters).sort(), ['one', 'two']);
  assert.deepEqual((await loadCachedPosters('account-B', ['one', 'two'])).posters, {});
});

test('legado sem proprietário não é importado ou apagado', async () => {
  const { entries, files } = (globalThis as any).__nativeStorageMocks;
  const clip = { id: 'old', cameraId: 'camera', cameraName: 'old', uri: 'file:///test/old.mp4', createdAt: new Date().toISOString() };
  files.set(clip.uri, true);
  entries.set('@drac:clips:v1', JSON.stringify([clip]));
  assert.deepEqual(await listClips('new-user'), []);
  assert.ok(entries.has('@drac:clips:v1'));
});

test('reparo da biblioteca e inclusão concorrente não perdem clipe', async () => {
  const { files } = (globalThis as any).__nativeStorageMocks;
  const clip = { id: 'new', cameraId: 'camera', cameraName: 'camera', uri: 'file:///test/new.mp4', createdAt: new Date().toISOString() };
  files.set(clip.uri, true);
  await Promise.all([listClips('owner'), addClip('owner', clip)]);
  assert.deepEqual((await listClips('owner')).map(c => c.id), ['new']);
});
