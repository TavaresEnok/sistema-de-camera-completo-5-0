import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectionNoticeMessage, selectMotionNotices } from '../src/lib/motion-notices.ts';

test('avisos simples distinguem movimento, pessoa, carro e moto sem porcentagens', () => {
  const base = { id: '1', cameraId: 'a', cameraName: 'Portaria', occurredAt: new Date().toISOString() };
  assert.equal(detectionNoticeMessage(base), 'Portaria detectou movimento.');
  assert.equal(detectionNoticeMessage({ ...base, detectionType: 'object', objectClass: 'person' }), 'Portaria detectou uma pessoa.');
  assert.equal(detectionNoticeMessage({ ...base, detectionType: 'object', objectClass: 'car' }), 'Portaria detectou um carro.');
  assert.equal(detectionNoticeMessage({ ...base, detectionType: 'object', objectClass: 'motorcycle' }), 'Portaria detectou uma moto.');
});

test('movimento não oculta pessoa; repetição da mesma classe continua limitada', () => {
  const now = Date.now(); const seen = new Set<string>(); const last = new Map<string, number>();
  const base = { cameraId: 'a', cameraName: 'Portaria', occurredAt: new Date(now).toISOString() };
  const items = [{ ...base, id: 'm' }, { ...base, id: 'p', detectionType: 'object' as const, objectClass: 'person' }];
  assert.equal(selectMotionNotices(items, seen, last, now).length, 2);
  assert.equal(selectMotionNotices([{ ...items[1], id: 'repeat' }], seen, last, now + 1000).length, 0);
});

test('mesmo controle nas duas abas, classes limitadas ao plano e uma única consulta de avisos', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const edit = source('../src/components/CameraEditSheet.tsx');
  assert.equal((edit.match(/<CameraDetectionNotices /g) ?? []).length, 2);
  assert.match(edit, /objectNoticeEnabled: form.objectNoticeEnabled/);
  assert.match(edit, /objectNoticeClasses: form.objectNoticeClasses/);
  const control = source('../src/components/CameraDetectionNotices.tsx');
  assert.match(control, /allowed.includes\(c.valor\)/);
  assert.match(control, /aria-label="Avisar na tela"/);
  assert.match(control, /Funciona mesmo sem gravação/);
  const notices = source('../src/components/MotionNotices.tsx');
  assert.match(notices, /cameras\/detection-notices/);
  assert.match(notices, /controller.abort\(\)/);
  assert.match(notices, /fullscreenchange/);
});
