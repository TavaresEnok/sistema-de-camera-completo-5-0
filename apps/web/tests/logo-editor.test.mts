import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imagePlacement } from '../../central/public/logo-image-editor.mjs';
test('logo starts centered without stretching, zoom and offsets change its position', () => {
  assert.deepEqual(imagePlacement(400, 200, 400, 400), { x: 0, y: 100, width: 400, height: 200 });
  assert.deepEqual(imagePlacement(400, 200, 400, 400, 0.5, 10, -20), { x: 110, y: 130, width: 200, height: 100 });
  assert.equal(imagePlacement(200, 400, 400, 400, 999).height, 2400);
});
test('settings opens editor for app logo, supports reediting and saves only on explicit Apply', () => {
  const settings = readFileSync(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8');
  assert.match(settings, /destino === 'brandLogoDataUrl'\) \{ setLogoEditorSource\(reader.result\); return;/);
  assert.match(settings, /Ajustar imagem/);
  assert.match(settings, /update\('brandLogoDataUrl', image\)/);
  const editor = readFileSync(new URL('../src/components/BrandLogoEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /ref=\{setCanvas\}/);
  assert.match(editor, /instance.destroy\(\)/);
  assert.match(editor, /Aplicar imagem/);
  assert.doesNotMatch(editor, /axios|fetch\(|generate-app|\/builds|localStorage/);
});
