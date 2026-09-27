import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const addDialogPath = fileURLToPath(new URL('../src/components/AddPushCameraDialog.tsx', import.meta.url));
const editSheetPath = fileURLToPath(new URL('../src/components/CameraEditSheet.tsx', import.meta.url));
const storePath = fileURLToPath(new URL('../src/store/vmsDataStore.ts', import.meta.url));

test('cadastro RTMP recomenda URL compacta e nunca orienta recortar a chave', async () => {
  const source = await readFile(addDialogPath, 'utf8');

  assert.match(source, /fullUrlFitsSingleField/);
  assert.match(source, /usaEnderecoCompacto/);
  assert.match(source, /Compatível com campos curtos/);
  assert.match(source, /Nunca a recorte/);
  assert.match(source, /selecione Personalizado/);
  assert.match(source, /Não personalizado/);
  assert.match(source, /Servidor RTMP/);
  assert.match(source, /Chave do stream/);
  assert.match(source, /Câmera usa um caminho próprio/);
  assert.match(source, /Vincular caminho/);
  assert.match(source, /setInterval\(carregarPendentes, 5_000\)/);
  assert.doesNotMatch(source, /pronto: não precisa configurar mais nada/);
});

test('edição RTMP bloqueia a falsa recomendação quando a URL excede o equipamento', async () => {
  const source = await readFile(editSheetPath, 'utf8');

  assert.match(source, /fullUrlFitsSingleField/);
  assert.match(source, /Endereço compacto selecionado/);
  assert.match(source, /URL maior que o campo da câmera/);
  assert.match(source, /Não recorte a chave/);
  assert.match(source, /use endereço Personalizado/);
  assert.match(source, /Não personalizado/);
  assert.match(source, /Equipamento com campos Servidor \+ Chave/);
  assert.match(source, /Câmera usa um caminho próprio/);
  assert.match(source, /Vincular caminho/);
  assert.match(source, /setInterval\(carregarPendentes, 5_000\)/);
});

test('detalhe e listagens não apresentam o marcador 0.0.0.0 como endereço de câmera RTMP', async () => {
  const [detail, store] = await Promise.all([
    readFile(editSheetPath, 'utf8'),
    readFile(storePath, 'utf8'),
  ]);

  assert.match(store, /sourceMode === 'rtmp_push' \? 'RTMP push' : camera\.ip/);
  assert.match(detail, /ingest\?\.sourceMode \?\? sourceMode/);
  assert.match(detail, /!modoPush \? \{/);
  assert.doesNotMatch(detail, /\{camera\.ipAddress\}/);
  assert.doesNotMatch(detail, />\{cam\.ipAddress\}<\/span>/);
});
