import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cameraPrivacyChanged, cameraPrivacyError, cameraPrivacyPayload, emptyCameraPrivacy } from '../src/lib/camera-privacy.ts';

test('comum não publica na internet nem envia antigo proprietário', () => {
  assert.deepEqual(cameraPrivacyPayload({ isPrivate: false, ownerUserId: 'old', privateViewerIds: ['delegate'] }), { isPrivate: false });
  assert.equal(cameraPrivacyError(emptyCameraPrivacy()), null);
});
test('privada exige dono, deduplica espectadores e não duplica proprietário', () => {
  assert.ok(cameraPrivacyError({ ...emptyCameraPrivacy(), isPrivate: true }));
  assert.deepEqual(cameraPrivacyPayload({ isPrivate: true, ownerUserId: 'owner', privateViewerIds: ['viewer', 'owner', 'viewer'] }), { isPrivate: true, ownerUserId: 'owner', privateViewerIds: ['viewer'] });
});
test('ordem e campos ocultos não alteram acessos; troca de dono exige confirmação', () => {
  assert.equal(cameraPrivacyChanged({ isPrivate: false, ownerUserId: 'old', privateViewerIds: ['x'] }, emptyCameraPrivacy()), false);
  assert.equal(cameraPrivacyChanged({ isPrivate: true, ownerUserId: 'a', privateViewerIds: ['y', 'x'] }, { isPrivate: true, ownerUserId: 'a', privateViewerIds: ['x', 'y'] }), false);
  assert.equal(cameraPrivacyChanged({ isPrivate: true, ownerUserId: 'b', privateViewerIds: [] }, { isPrivate: true, ownerUserId: 'a', privateViewerIds: [] }), true);
});
test('controle nos dois cadastros e edição, gravações antigas e confirmação explícita', () => {
  const source = (name: string) => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
  for (const file of ['pages/CamerasPage.tsx', 'components/AddPushCameraDialog.tsx', 'components/CameraEditSheet.tsx']) assert.match(source(file), /<CameraPrivacyFields /);
  const edit = source('components/CameraEditSheet.tsx');
  assert.match(edit, /privacyConfirmed: true, expectedUpdatedAt: privacyRevision.current, expectedPrivacyRevision: privacyAccessRevision.current/);
  assert.match(edit, /Confirmar alteração de privacidade/);
  assert.match(edit, /gravações antigas/);
  assert.match(source('components/CameraPrivacyFields.tsx'), /signal, headers/);
});
