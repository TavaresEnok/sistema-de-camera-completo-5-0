import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { equipmentError, equipmentPayload, legacyCameraDestination, readEquipment } from '../src/lib/camera-edit.ts';

test('links antigos preservam câmera e destino sem liberar edição para operador', () => {
  assert.equal(legacyCameraDestination('a b', 'settings', true), '/cameras?edit=a%20b');
  assert.equal(legacyCameraDestination('a', 'settings', false), '/cameras?cameraId=a');
  for (const [tab, page] of [['ptz', 'ptz'], ['playback', 'playback'], ['zones', 'perimetro'], ['events', 'alarms']]) {
    assert.equal(legacyCameraDestination('a', tab, true), `/${page}?cameraId=a`);
  }
  assert.equal(legacyCameraDestination('a', null, true), '/cameras?cameraId=a');
});
test('perfis personalizados e valores zero sobrevivem à leitura e gravação', () => {
  const form = readEquipment({ liveSubtype: 0, channel: 3, recordingSubtype: 7 });
  assert.equal(equipmentError(form), null);
  assert.deepEqual(Object.fromEntries(Object.entries(equipmentPayload(form, false)).filter(([key]) => ['channel', 'liveSubtype', 'recordingSubtype'].includes(key))), { channel: 3, liveSubtype: 0, recordingSubtype: 7 });
  assert.equal(equipmentPayload(form, false).analyticsChannel, null);
});
test('publicação não sobrescreve canais, perfis ou acesso ONVIF', () => {
  const payload = equipmentPayload(readEquipment({ channel: 9, onvifPath: '/secret', recordingWidth: 1920, recordingHeight: 1080 }), true);
  assert.equal(payload.recordingWidth, 1920);
  for (const key of ['channel', 'subtype', 'liveChannel', 'liveSubtype', 'onvifPath', 'onvifProfileToken']) assert.ok(!(key in payload));
});
test('validação rejeita números inválidos e resolução incompleta', () => {
  for (const data of [{ channel: 0 }, { liveSubtype: -1 }, { recordingFps: 1.5 }, { streamBitrateKbps: 'abc' }, { recordingWidth: 1920 }]) assert.ok(equipmentError(readEquipment(data)));
});
test('edição única protege rascunho, permissão e respostas de outras câmeras', () => {
  const read = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const sheet = read('components/CameraEditSheet.tsx');
  assert.match(sheet, /!camera \|\| !canEdit/);
  assert.match(sheet, /beforeunload/);
  assert.match(sheet, /Descartar as alterações/);
  assert.match(sheet, /!modoPush \? \{/);
  assert.match(read('pages/CamerasPage.tsx'), /consumedCameraSearch/);
  assert.match(read('components/CameraConnectionCheck.tsx'), /run !== generation.current/);
  assert.match(read('components/CameraConnectionCheck.tsx'), /parsePreviewFrame/);
  assert.doesNotMatch(read('App.tsx'), /CameraDetailPage/);
});
