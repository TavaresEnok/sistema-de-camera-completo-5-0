import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldShowDetectorLabel } from '../src/lib/detector-label.ts';
import { measuredCpuPercent } from '../src/lib/measured-cpu.ts';

test('grid oculta texto por padrão e respeita opção por câmera; tela única não muda', () => {
  assert.equal(shouldShowDetectorLabel('grid'), false);
  assert.equal(shouldShowDetectorLabel('grid', false), false);
  assert.equal(shouldShowDetectorLabel('grid', true), true);
  assert.equal(shouldShowDetectorLabel('selected', false), true);
  const overlay = readFileSync(new URL('../src/components/SmoothDetectionOverlay.tsx',import.meta.url),'utf8');
  assert.match(overlay, /\{showLabels && <span/);
  assert.match(overlay, /border-2/);
});

test('preferência percorre cadastro, payload, store e player, sem ligar IA', () => {
  const source = (path: string) => readFileSync(new URL(path,import.meta.url),'utf8');
  assert.match(source('../src/components/CameraEditSheet.tsx'), /Mostrar porcentagem do detector/);
  assert.match(source('../src/components/CameraEditSheet.tsx'), /showDetectorPercentage: form.showDetectorPercentage/);
  assert.match(source('../src/store/vmsDataStore.ts'), /showDetectorPercentage: camera.showDetectorPercentage === true/);
  assert.match(source('../src/components/CameraTile.tsx'), /showDetectorPercentage=\{camera.showDetectorPercentage\}/);
  assert.match(source('../src/components/LiveStreamPlayer.tsx'), /shouldShowDetectorLabel\(detectionDisplayMode, showDetectorPercentage\)/);
  assert.match(source('../src/pages/LiveViewPage.tsx'), /detectionDisplayMode=\{focusedCameraId === cam.id \? 'selected' : 'grid'\}/);
});

test('indicador usa CPU medida; dado ausente nunca vira carga estimada nem falso 0%', () => {
  assert.equal(measuredCpuPercent(69.1),69);
  for (const v of [undefined,null,NaN,Infinity,'69']) assert.equal(measuredCpuPercent(v),null);
  assert.equal(measuredCpuPercent(110),100);
  const source = readFileSync(new URL('../src/pages/PerformancePage.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(source,/server\.loadAverage\[0\]/);
  assert.match(source,/uso medido no servidor/);
});
