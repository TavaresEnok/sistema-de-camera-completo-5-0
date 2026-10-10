import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const player = await readFile(new URL('../src/components/LiveStreamPlayer.tsx', import.meta.url), 'utf8');
const tile = await readFile(new URL('../src/components/CameraTile.tsx', import.meta.url), 'utf8');

test('grid opts into audio without enabling AI or technical overlays', () => {
  assert.match(tile, /showOverlay=\{showDetectionOverlay && !wallMode && !showOfflineOverlay\}/);
  assert.match(tile, /showAudioControl=\{!showOfflineOverlay && routeActive && playbackEnabled\}/);
  assert.match(player, /showAudioControl = showOverlay/);
  assert.match(player, /const aiOverlayEnabled = showOverlay && aiEnabled/);
});

test('audio escapes player containment into a tile-local host above selection, also in wall mode', () => {
  assert.match(player, /contain: 'layout paint style', isolation: 'isolate'/);
  assert.match(player, /createPortal\(audioControl, audioControlContainer\)/);
  assert.match(tile, /className="absolute inset-0 z-\[15\]/);
  assert.match(tile, /camera-tile-topbar[^\n]*z-40/);
  assert.match(tile, /!contentLocked && <div ref=\{setAudioControlContainer\}/);
  assert.match(player, /pointer-events-auto relative h-11 w-11/);
});

test('audio interaction does not select or expand the camera; pending activation can be muted', () => {
  assert.match(player, /const audioControl = showAudioControl && \(!error \|\| !isMuted\) && \(!isLoading \|\| hasLiveFrame \|\| audioSwitchMessage\)/);
  assert.match(player, /onDoubleClick=\{event => event.stopPropagation\(\)\}/);
  assert.match(player, /onClick=\{event => \{\s*event.stopPropagation\(\);\s*const nextMuted = !isMuted/);
  assert.match(player, /element.muted = nextMuted/);
  assert.match(player, /aria-label=\{`\$\{isMuted \? 'Ativar áudio' : 'Desativar áudio'\} de \$\{cameraName\}`\}/);
});

test('grid remains silent initially and requests audio only on this player after a click', () => {
  assert.match(tile, /\s+muted\s/);
  assert.match(player, /const \[gridAudioRequested, setGridAudioRequested\] = useState\(false\)/);
  assert.match(player, /if \(!nextMuted && !gridAudioRequested\)/);
  assert.match(player, /gridAudioRequested \? 'grid-audio'/);
});
