import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('PTZ mostra deslocamento em graus e não expõe velocidade ao operador', () => {
  const page = read('src/pages/PTZPage.tsx');
  for (const source of [page]) {
    assert.match(source, /Movimento por toque/);
    assert.match(source, /angleDegrees/);
  }
  assert.doesNotMatch(page, />Velocidade</);
  assert.doesNotMatch(page, /durationMs:\s*160|speed:\s*5/);
  assert.match(page, /\[2, 5, 10, 20\]/);
  assert.doesNotMatch(page, /onPointerUp=\{onStop\}/, 'soltar um toque não deve enviar uma segunda parada');
});

test('cliente PTZ troca mensagens técnicas por orientação humana', () => {
  const client = read('src/lib/ptz.ts');
  assert.match(client, /friendlyPtzError/);
  assert.match(client, /porta ONVIF ou HTTP/);
  assert.match(client, /Não foi possível mover a câmera agora/);
});
