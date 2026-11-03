import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { advanceNoticeQueue, detectionNoticeMessage, selectMotionNotices, type TimedMotionNotice } from '../src/lib/motion-notices.ts';

test('todos os avisos de uma rajada recebem tempo completo, mesmo após longa espera', () => {
  for (const duration of [10,30,60,120]) {
    let queue: TimedMotionNotice[] = Array.from({length:15},(_,i)=>({id:String(i),cameraId:'a',cameraName:'A',occurredAt:new Date(0).toISOString(),queuedAt:0,expiresAt:null,noticeDurationSeconds:duration}));
    const displayed = new Set<string>();
    for(let time=0;time<=duration*6000;time+=1000) {
      queue=advanceNoticeQueue(queue,time);
      for(const item of queue.slice(0,3)) {
        if(!displayed.has(item.id)) assert.equal(item.expiresAt! - time,duration*1000);
        displayed.add(item.id);
      }
    }
    assert.equal(displayed.size,15);
    assert.equal(queue.length,0);
  }
});

test('avisos simples distinguem movimento, pessoa, carro e moto sem porcentagens', () => {
  const base = { id: '1', cameraId: 'a', cameraName: 'Portaria', occurredAt: new Date().toISOString() };
  assert.equal(detectionNoticeMessage(base), 'Portaria detectou movimento.');
  assert.equal(detectionNoticeMessage({ ...base, detectionType: 'object', objectClass: 'person' }), 'Portaria detectou uma pessoa.');
  assert.equal(detectionNoticeMessage({ ...base, detectionType: 'object', objectClass: 'car' }), 'Portaria detectou um carro.');
  assert.equal(detectionNoticeMessage({ ...base, detectionType: 'object', objectClass: 'motorcycle' }), 'Portaria detectou uma moto.');
});

test('movimento não oculta pessoa; eventos confirmados distintos não são descartados', () => {
  const now = Date.now(); const seen = new Set<string>(); const last = new Map<string, number>();
  const base = { cameraId: 'a', cameraName: 'Portaria', occurredAt: new Date(now).toISOString() };
  const items = [{ ...base, id: 'm' }, { ...base, id: 'p', detectionType: 'object' as const, objectClass: 'person' }];
  assert.equal(selectMotionNotices(items, seen, last, now).length, 2);
  assert.equal(selectMotionNotices([{ ...items[1], id: 'another-person' }], seen, last, now + 1000).length, 1);
  assert.equal(selectMotionNotices([items[1]], seen, last, now + 1000).length, 0);
});

test('presença não oculta travessia; duas linhas e quatro câmeras conservam seus eventos', () => {
  const now = Date.now(), seen = new Set<string>(), last = new Map<string, number>();
  const base = { cameraId: 'a', cameraName: 'Portaria', occurredAt: new Date(now).toISOString(), detectionType: 'object' as const, objectClass: 'person' };
  assert.equal(selectMotionNotices([{...base,id:'presence'}],seen,last,now).length,1);
  const crossings = [1,2].map(i=>({...base,id:`line-${i}`,perimeterCrossing:true}));
  assert.equal(selectMotionNotices(crossings,seen,last,now+5000).length,2);
  assert.equal(selectMotionNotices(crossings,seen,last,now+6000).length,0);
  assert.equal(selectMotionNotices([1,2,3,4].map(i=>({...base,id:`other-${i}`,cameraId:`cam-${i}`})),seen,last,now+7000).length,4);
});

test('recupera eventos após uma pausa curta do navegador, sem mostrar eventos antigos', () => {
  const now=Date.now(), base={cameraId:'a',cameraName:'A',detectionType:'object' as const,objectClass:'person'};
  assert.equal(selectMotionNotices([{...base,id:'recover',occurredAt:new Date(now-65000).toISOString()}],new Set(),new Map(),now).length,1);
  assert.equal(selectMotionNotices([{...base,id:'old',occurredAt:new Date(now-121000).toISOString()}],new Set(),new Map(),now).length,0);
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
