import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('personalização: envia só alterações e preserva edições feitas durante o salvamento', () => {
  const page = source('pages/SettingsPage.tsx');
  assert.match(page, /Object\.entries\(snapshot\)\.filter/);
  assert.match(page, /value !== baseline\[key as keyof SystemSettings\]/);
  assert.match(page, /setSettings\(\{ \.\.\.data, \.\.\.edits \}\)/);
  assert.match(page, /useUnsavedChanges\(dirty\)/);
  assert.match(page, /Alterações não salvas/);
  assert.match(page, /png\.length > 550000/);
});
test('grupos: confirma transferência, bloqueia repetição e não mostra IPs', () => {
  const page = source('pages/GroupsPage.tsx');
  assert.match(page, /Transferir câmera\?/);
  assert.match(page, /expectedGroupId: confirmedFrom/);
  assert.match(page, /disabled=\{cameraBusy\}/);
  assert.match(page, /sequence !== loadSequence\.current/);
  assert.doesNotMatch(page, /cam\.ipAddress/);
  assert.match(page, /Buscar grupos/);
});
test('menu, busca e rotas administrativas usam a mesma política de permissões', () => {
  for (const path of ['App.tsx', 'components/Sidebar.tsx', 'components/CommandPalette.tsx']) {
    assert.match(source(path), /ADMIN_PAGE_PERMISSION/);
    assert.match(source(path), /hasPermission\(|canUsePermission/);
  }
  const store = source('store/permissionsStore.ts');
  assert.match(store, /current = \+\+generation/);
  assert.match(store, /generation === current/);
  assert.match(store, /SUPER_ADMIN/);
  assert.match(source('App.tsx'), /permissionActor\.current !== actorId/);
});
test('rondas: falha HTTP não vira lista vazia nem exclusão aparente', () => {
  const page = source('pages/RondaPage.tsx');
  assert.match(page, /!rRondas\.ok \|\| !rLayouts\.ok/);
  assert.match(page, /if \(!response\.ok\)/);
  assert.match(page, /requestBusy\.current/);
  assert.match(page, /catch \{/);
  assert.match(page, /disabled=\{salvando \|\|/);
  assert.match(page, /role="alert"/);
});
test('funções: teclado, leitura em tela estreita e descarte confirmado', () => {
  const page = source('pages/RolesPage.tsx');
  assert.match(page, /onKeyDown/);
  assert.match(page, /overflow-x-auto/);
  assert.match(page, /Descartar alterações\?/);
  assert.match(page, /permissões abaixo/);
  assert.match(page, /aria-label=\{PERMISSION_LABELS/);
});
