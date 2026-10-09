import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('qualidade aguarda o perfil escolhido e descarta respostas atrasadas', () => {
  const hook = readFileSync('src/hooks/useLiveQuality.ts', 'utf8');
  assert(hook.includes('generation.current !== current'));
  assert(hook.includes('loading: true, failed: false'));
  assert(hook.includes('failed: !opened'));
  assert(hook.includes('return () => { generation.current += 1; }'));
  for (const screen of ['src/screens/LiveScreen.tsx', 'src/screens/redesign/LiveScreenRedesign.tsx']) {
    const source = readFileSync(screen, 'utf8');
    assert(source.includes('qualityLoading || qualityFailed || (hdMode && !hdAvailable)'));
    assert(source.includes("{hdMode ? 'HD+' : 'Economia'}"));
    assert(source.includes('onPress={retryQuality}'));
  }
});

test('Economia solicita o perfil reduzido e mantém a escolha com áudio', () => {
  const app = readFileSync('App.tsx', 'utf8');
  const exit = app.slice(app.indexOf('const exitHdStream'), app.indexOf('// Posters ficam'));
  assert(exit.includes('hdRequestRef.current += 1'));
  assert(exit.includes('setHdUrl(null)') && exit.includes('setHdWhepUrl(null)'));
  assert(exit.includes('return loadStream(cameraId, modoDaGrade())'));
  assert.equal((app.match(/onExitHd=\{\(\) => exitHdStream\(live.id\)\}/g) ?? []).length, 2);
  assert(app.includes("? 'grid-audio' : 'grid'"));
  const hook = readFileSync('src/hooks/useLiveQuality.ts', 'utf8');
  assert(hook.includes('if (turningOn) void select(selectedHd.current)'));
  const hd = app.slice(app.indexOf('const loadHdStream'), app.indexOf('const login ='));
  assert(!hd.includes('void loadStream('), 'abrir HD não deve iniciar conversão reduzida sem necessidade');
});

test('nome e avatar abrem Configurações nos dois layouts', () => {
  const app = readFileSync('App.tsx', 'utf8');
  assert.equal((app.match(/onOpenSettings=\{\(\) => setTab\('ajustes'\)\}/g) ?? []).length, 2);
  for (const screen of ['src/screens/CentralScreen.tsx', 'src/screens/redesign/HomeRedesign.tsx']) {
    const source = readFileSync(screen, 'utf8');
    assert(source.includes('accessibilityLabel="Abrir configurações"'));
    assert(source.includes('accessibilityLabel="Configurações da conta"'));
    assert(source.includes('minHeight: 44'));
  }
  for (const screen of ['src/screens/SettingsScreen.tsx', 'src/screens/redesign/SettingsRedesign.tsx']) {
    const source = readFileSync(screen, 'utf8');
    assert(source.includes('>Configurações</Text>'));
    assert(!source.includes('>Ajustes</Text>'));
  }
});

test('app não exibe Ronda nem consulta rondas em segundo plano', () => {
  for (const file of ['src/components/BottomTabs.tsx', 'src/components/BottomTabsRedesign.tsx']) {
    const source = readFileSync(file, 'utf8');
    assert(!source.includes("id: 'ronda'"));
    assert(source.includes("label: 'Config.'"));
    assert(source.includes("'Configurações'"));
  }
  const app = readFileSync('App.tsx', 'utf8');
  assert(!app.includes('RondaScreen'));
  assert(!app.includes('carregarRondas'));
  assert(!app.includes("'/rondas'") && !app.includes("'/live-layouts'"));
});
