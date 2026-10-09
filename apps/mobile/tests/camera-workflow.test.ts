import assert from 'node:assert/strict';
import test from 'node:test';
import { findOwnedCameraDuplicate } from '../src/services/camera-duplicate';
import { saveCameraSetupDraft, loadCameraSetupDraft, clearCameraSetupDraft, type CameraSetupDraft } from '../src/services/camera-setup-draft';
import type { Camera } from '../src/types';

const camera = { id: 'mine', name: 'Entrada', ip: '192.168.0.10', rtspPort: 5540, rtspPath: '/video?channel=1', canSelfManage: true } as Camera;
test('duplicate detection keeps NVR channels, ports and other owners separate', () => {
  const candidate = { ip: ' 192.168.0.10 ', rtspPort: '5540', rtspPath: 'video?channel=1' };
  assert.equal(findOwnedCameraDuplicate([camera], candidate)?.id, 'mine');
  assert.equal(findOwnedCameraDuplicate([camera], { ...candidate, rtspPort: 554 }), null);
  assert.equal(findOwnedCameraDuplicate([camera], { ...candidate, rtspPath: '/video?channel=2' }), null);
  assert.equal(findOwnedCameraDuplicate([{ ...camera, canSelfManage: false }], candidate), null);
  assert.equal(findOwnedCameraDuplicate([{ ...camera, sourceMode: 'rtmp_push' }], candidate), null);
});
test('duplicate normalization accepts IPv6 brackets but preserves case-sensitive paths', () => {
  const value = { ...camera, ip: '2001:DB8::1', rtspPath: '/Video' };
  assert.equal(findOwnedCameraDuplicate([value], { ip: '[2001:db8::1]', rtspPort: 5540, rtspPath: '/Video' })?.id, 'mine');
  assert.equal(findOwnedCameraDuplicate([value], { ip: '[2001:db8::1]', rtspPort: 5540, rtspPath: '/video' }), null);
});
const draft: CameraSetupDraft = { sourceMode: 'rtsp_pull', name: 'Portão', ip: '192.168.0.10', rtspPort: '5540', automaticPort: false, httpPort: '8000', onvifPort: '8000', username: 'admin', password: ' secret with spaces ', rtspPath: '/video' };
test('draft survives a new read, isolates users/installations and uses protected storage', async () => {
  const mocks = (globalThis as any).__nativeStorageMocks;
  await saveCameraSetupDraft('https://a.test/api/', 'alice', draft);
  assert.deepEqual(await loadCameraSetupDraft('https://a.test/api', 'alice'), draft);
  assert.equal(await loadCameraSetupDraft('https://a.test/api', 'bob'), null);
  assert.equal(await loadCameraSetupDraft('https://b.test/api', 'alice'), null);
  assert(!JSON.stringify([...mocks.entries]).includes(draft.password));
  const values = [...mocks.secureEntries.values()] as string[];
  assert(values.includes(draft.password));
  assert(!values.filter(v => v.startsWith('{')).some(v => v.includes(draft.password)));
});
test('clear is serialized after pending writes so a completed form cannot reappear', async () => {
  const first = saveCameraSetupDraft('https://a.test', 'race', draft);
  const second = saveCameraSetupDraft('https://a.test', 'race', { ...draft, name: 'Updated' });
  const cleared = clearCameraSetupDraft('https://a.test', 'race');
  await Promise.all([first, second, cleared]);
  assert.equal(await loadCameraSetupDraft('https://a.test', 'race'), null);
});
test('old and malformed drafts are not restored', async () => {
  const mocks = (globalThis as any).__nativeStorageMocks;
  await saveCameraSetupDraft('https://old.test', 'alice', draft);
  const key = [...mocks.secureEntries.keys()].find((k: string) => !k.endsWith('.password') && JSON.parse(mocks.secureEntries.get(k)).fields?.ip === draft.ip && k.includes(Buffer.from('old.test').toString('hex')));
  assert(key);
  const value = JSON.parse(mocks.secureEntries.get(key)); value.savedAt -= 25 * 60 * 60 * 1000;
  mocks.secureEntries.set(key, JSON.stringify(value));
  assert.equal(await loadCameraSetupDraft('https://old.test', 'alice'), null);
  assert.equal(mocks.secureEntries.has(key + '.password'), false);
});
