import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('câmera em verificação pede imagem como qualquer câmera habilitada', () => {
  const page = read('src/pages/CamerasPage.tsx');
  assert.match(page, /camera\.enabled && camera\.canViewContent/);
  assert.doesNotMatch(page, /cameras\.filter\(\(camera\) => camera\.isOnline\)\.map\(\(camera\) => camera\.id\)/);
});

test('UNKNOWN não é traduzido como Sem sinal e uma imagem carregada não fica escondida', () => {
  const store = read('src/store/vmsDataStore.ts');
  const page = read('src/pages/CamerasPage.tsx');
  assert.match(store, /status === 'UNKNOWN'\) return 'checking'/);
  assert.match(page, /checking: 'Em verificação'/);
  assert.match(page, /posterLoaded\.has\(cam\.id\)/);
  assert.match(page, /onLoad=\{\(\) => setPosterLoaded/);
});

test('falha de uma imagem não dispara recarga em cascata de todas as câmeras', () => {
  const page = read('src/pages/CamerasPage.tsx');
  const retry = page.split('const retryPoster = useCallback')[1].split('const isRecordingAutoRecovering')[0];
  assert.doesNotMatch(retry, /loadPosterTokens\(/);
  assert.match(retry, /setPosterFailed/);
});
