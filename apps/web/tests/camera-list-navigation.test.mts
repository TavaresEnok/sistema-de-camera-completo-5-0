import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const camerasPage = readFileSync(new URL('../src/pages/CamerasPage.tsx', import.meta.url), 'utf8');
const livePage = readFileSync(new URL('../src/pages/LiveViewPage.tsx', import.meta.url), 'utf8');
const mapPage = readFileSync(new URL('../src/pages/MapPage.tsx', import.meta.url), 'utf8');
const editSheet = readFileSync(new URL('../src/components/CameraEditSheet.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('clicar na linha ou no cartão abre a câmera individual, sem roubar o botão editar', () => {
  assert.match(camerasPage, /setSelectedCam\(cameras.find/);
  assert.match(camerasPage, /liveViewMode="selected"/);
  assert.ok(
    (camerasPage.match(/onClick=\{\(\) => openCamera\(cam\.id\)\}/g) ?? []).length >= 2,
    'tabela e cartões precisam compartilhar a navegação individual',
  );
  assert.match(camerasPage, /onClick=\{\(\) => setEditCamera\(cam\)\}/);
});

test('painel lateral do ao vivo usa poster autenticado, lote e carregamento tardio', () => {
  assert.match(livePage, /camera-stream\/poster-tokens/);
  assert.match(livePage, /loading="lazy"/);
  assert.match(livePage, /if \(!panelOpen\) return/);
  assert.match(livePage, /retrySidebarPoster\(cam\.id\)/);
});

test('painel lateral do mapa acompanha o ao vivo com busca, filtros e snapshots autenticados', () => {
  assert.match(mapPage, /camera-stream\/poster-tokens/);
  assert.match(mapPage, /placeholder="Buscar câmera\.\.\."/);
  assert.match(mapPage, /STATUS_FILTERS\.map/);
  assert.match(mapPage, /loading="lazy"/);
  assert.match(mapPage, /retrySidebarPoster\(camera\.id\)/);
  assert.match(mapPage, /openCamera\(camera\)/);
});

test('gaveta de edição descreve o conteúdo para leitores de tela', () => {
  assert.match(editSheet, /SheetDescription/);
  assert.match(editSheet, /Editar identificação, transmissão e gravação da câmera/);
});

test('barra de rolagem horizontal permanece visível em tabelas estreitas', () => {
  assert.match(camerasPage, /ops-card overflow-x-auto/);
  // A interface operacional usa uma barra propositalmente discreta, mas com
  // contraste suficiente para continuar encontrável em tabelas horizontais.
  assert.match(css, /::-webkit-scrollbar \{ width: 3px; height: 3px; \}/);
  assert.match(css, /scrollbar-color: hsl\(var\(--primary\) \/ 0\.62\) transparent/);
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{[\s\S]*background: hsl\(var\(--primary\) \/ 0\.58\)/);
});
