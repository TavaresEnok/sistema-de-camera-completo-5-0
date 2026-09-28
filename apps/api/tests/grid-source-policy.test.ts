import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeDeveUsarPrincipalPorFormato,
  gridFollowsCameraProfile,
  parseGridSourcePolicy,
} from '../src/camera-stream/helpers/live-delivery-profile.helper';

// Incidente Vibe 15/09/2026: a câmera marcada "Original da câmera" aparecia na
// grade com tarja, porque a grade ignorava o cadastro e usava o stream 2 (4:3).

test('política da grade: só "camera" liga; qualquer outro valor mantém o padrão leve', () => {
  assert.equal(parseGridSourcePolicy('camera'), 'camera');
  assert.equal(parseGridSourcePolicy('  CAMERA '), 'camera');
  assert.equal(parseGridSourcePolicy(undefined), 'sub');
  assert.equal(parseGridSourcePolicy(''), 'sub');
  assert.equal(parseGridSourcePolicy('main'), 'sub', 'valor desconhecido nunca muda a frota por engano');
});

test('com "camera", a grade segue o cadastro e o Instantâneo continua no stream 2', () => {
  assert.equal(gridFollowsCameraProfile('grid', 'camera'), true);
  assert.equal(gridFollowsCameraProfile('grid-hevc', 'camera'), true);
  assert.equal(gridFollowsCameraProfile('grid-audio', 'camera'), true, 'ativar áudio preserva a fonte da grade');
  assert.equal(gridFollowsCameraProfile('original', 'camera'), false);
});

test('com o padrão "sub", nada muda para nenhum modo', () => {
  for (const mode of ['grid', 'grid-hevc', 'grid-audio', 'original', 'original-audio'] as const) {
    assert.equal(gridFollowsCameraProfile(mode, 'sub'), false, mode);
  }
});

test('stream 2 fora do formato do principal é detectado (tarja na grade)', async () => {
  const { streamDiffersInAspect } = await import('../src/camera-stream/helpers/live-delivery-profile.helper');
  const principal = { width: 1920, height: 1080 };
  assert.equal(streamDiffersInAspect({ width: 640, height: 480 }, principal), true, '4:3 contra 16:9 (Cam-04/06, TESTE CAM)');
  assert.equal(streamDiffersInAspect({ width: 704, height: 480 }, principal), true, 'D1 contra 16:9 (Cam-05)');
  assert.equal(streamDiffersInAspect({ width: 640, height: 360 }, principal), false, 'mesmo formato: segue no stream 2');
  assert.equal(streamDiffersInAspect({ width: 640, height: 352 }, { width: 640, height: 352 }), false);
  assert.equal(streamDiffersInAspect({ width: 640, height: 480 }, { width: null, height: 1080 }), false, 'sem medida do principal: não muda nada');
  assert.equal(streamDiffersInAspect(null, principal), false);
});

// ── Formato diferente NÃO justifica trocar imagem boa por nenhuma ───────────
// 18/09/2026, IBTelecom, Grupo Flash Cam-05 (Dahua): stream 2 H.264 704×480
// funcionando; a regra da tarja trocou para o principal H.265 1920×1080, que
// chegava corrompido ("Error constructing the frame RPS"). Tile preto a 0 fps.

test('o caso real: principal H.265 NUNCA substitui o stream 2 por causa de tarja', () => {
  assert.equal(
    gradeDeveUsarPrincipalPorFormato({ subDiffersInAspect: true, mainCodec: 'h265', mainIsHevc: true }),
    false,
  );
  // Mesmo se o rótulo de codec vier vazio, a flag isHevc manda.
  assert.equal(
    gradeDeveUsarPrincipalPorFormato({ subDiffersInAspect: true, mainCodec: null, mainIsHevc: true }),
    false,
  );
});

test('principal H.264 com formato diferente: troca (é o caso que a regra existe para resolver)', () => {
  for (const codec of ['h264', 'H264', 'avc', 'avc1']) {
    assert.equal(
      gradeDeveUsarPrincipalPorFormato({ subDiffersInAspect: true, mainCodec: codec, mainIsHevc: false }),
      true,
      codec,
    );
  }
});

test('codec do principal desconhecido: na dúvida, fica no stream 2 que funciona', () => {
  assert.equal(
    gradeDeveUsarPrincipalPorFormato({ subDiffersInAspect: true, mainCodec: null, mainIsHevc: null }),
    false,
  );
});

test('mesmo formato: nunca troca, qualquer que seja o codec', () => {
  assert.equal(
    gradeDeveUsarPrincipalPorFormato({ subDiffersInAspect: false, mainCodec: 'h264', mainIsHevc: false }),
    false,
  );
});
