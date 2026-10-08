import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Instantâneo explica a preferência por menor atraso sem prometer redução obrigatória', () => {
  const source = readFileSync(new URL('../src/components/LiveStreamPlayer.tsx', import.meta.url), 'utf8');
  assert.match(source, /Prioriza menor atraso/);
  assert.match(source, /Se a câmera enviar apenas 1080p/);
  assert.doesNotMatch(source, /'Qualidade original'/);
  assert.match(source, /!compactLiveOverlay && showsVideoTranscode \?/);
});

test('reprodução usa ponteiros e libera arrastes ao cancelar o toque', () => {
  const source = readFileSync(new URL('../src/pages/PlaybackPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /onPointerDown=\{onTimelinePanStart\}/);
  assert.match(source, /addEventListener\('pointercancel'/);
  assert.match(source, /removeEventListener\('pointercancel'/);
  assert.match(source, /onPointerCancel=\{onVideoDragEnd\}/);
});
