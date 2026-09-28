import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const proxy = readFileSync(join(raiz, 'src/camera-stream/mediamtx-proxy.service.ts'), 'utf8');

test('áudio só cria publisher no perfil solicitado e converte AAC para Opus', () => {
  assert.match(proxy, /const wantsAudio = deliveryMode === 'grid-audio' \|\| deliveryMode === 'original-audio'/);
  assert.match(proxy, /const needsPublisher = \(wantsAudio && audioAvailable !== false\)/);
  assert.match(proxy, /-map 0:a:0\? -c:a libopus -b:a 64k -ac 1 -ar 48000/);
});

test('grade padrão remove a trilha e não depende do campo de cadastro', () => {
  assert.match(proxy, /const audioArgs = wantsAudio[\s\S]*?'-map 0:a:0\? -c:a libopus[\s\S]*?: '-an'/);
  assert.doesNotMatch(proxy, /isHevc \|\| sanitizeGridSource \|\| Boolean\(camera\.audioEnabled\)/);
});
