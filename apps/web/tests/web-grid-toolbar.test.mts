import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const tile = await readFile(new URL('../src/components/CameraTile.tsx', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/pages/LiveViewPage.tsx', import.meta.url), 'utf8');
const player = await readFile(new URL('../src/components/LiveStreamPlayer.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/responsive.css', import.meta.url), 'utf8');

test('one nonwrapping top row owns audio and actions, not independent absolute layers', () => {
  assert.match(tile, /camera-tile-topbar[^\n]*flex-nowrap/);
  assert.match(tile, /min-w-0 flex-1 overflow-hidden/);
  assert.doesNotMatch(tile, /camera-touch-actions|absolute bottom-1 left-1\/2/);
  assert.doesNotMatch(page, /absolute top-9 right-1\.5/);
  assert.match(page, /onReplace=\{\(\) => selectSlotForCamera\(i, cam\)\}/);
  assert.match(page, /onRemove=\{\(\) => removeCameraFromSlot\(i\)\}/);
});

test('small tiles keep all actions in an accessible menu, including fullscreen', () => {
  assert.match(css, /@container \(max-width: 359px\).*camera-tile-record/);
  assert.match(css, /@container \(max-width: 259px\).*camera-tile-expand/);
  assert.match(tile, /DropdownMenu\.Portal container=\{document.fullscreenElement/);
  for (const action of ['record-stop', 'ptz', 'playback', 'fullscreen', 'info']) assert.ok(tile.includes(action));
  assert.match(tile, /DropdownMenu.Item onSelect=\{onReplace\}/);
  assert.match(tile, /DropdownMenu.Item onSelect=\{onRemove\}/);
  assert.match(tile, /disabled=\{recordingBusy\}/);
  assert.match(tile, /canRecord && camera.recordingMode !== 'continuous'/);
});

test('technical details and quality use a menu portal without changing AI subscriptions', () => {
  assert.match(tile, /streamControlsInMenu\s+streamControlsContainer=\{streamControlsContainer\}/);
  assert.match(player, /container \? createPortal\(children, container\) : null/);
  assert.match(player, /const aiOverlayEnabled = showOverlay && aiEnabled/);
  assert.match(player, /onClick=\{\(\) => changeQuality\(mode\)\}/);
  assert.match(tile, /contentLocked \? \([\s\S]*?\) : \([\s\S]*?<LiveStreamPlayer/);
});
