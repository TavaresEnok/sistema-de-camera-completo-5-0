import assert from 'node:assert/strict';
import test from 'node:test';
import { findAlarmRecording } from '../src/services/alarm-recording';
import { loadCameraList } from '../src/services/camera-list';
import type { Session, Alarm } from '../src/types';

const session = { apiUrl: 'https://test.invalid/api', token: 'test', user: { id: 'test' } } as Session;
test('lista paginada carrega todas as páginas sem duplicar câmeras', async () => {
  const old = global.fetch;
  let calls = 0;
  global.fetch = async () => new Response(JSON.stringify(++calls === 1 ? { items: [{ id: 'a' }, { id: 'b' }], total: 3 } : { items: [{ id: 'c' }], total: 3 }));
  try { assert.deepEqual((await loadCameraList(session)).map(c => c.id), ['a', 'b', 'c']); assert.equal(calls, 2); }
  finally { global.fetch = old; }
});
test('ocorrência abre somente gravação que cobre o instante, nunca a cena atual', async () => {
  const old = global.fetch;
  const alarm = { cameraId: 'cam', occurredAt: '2026-09-27T12:00:05Z' } as Alarm;
  global.fetch = async () => new Response(JSON.stringify({ items: [{ id: 'rec', cameraId: 'cam', startedAt: '2026-09-27T12:00:00Z', endedAt: '2026-09-27T12:01:00Z' }] }));
  try {
    assert.equal((await findAlarmRecording(session, alarm))?.offset, 5);
    assert.equal(await findAlarmRecording(session, { ...alarm, cameraId: 'other' }), null);
    global.fetch = async () => new Response('{"items":[]}');
    assert.equal(await findAlarmRecording(session, alarm), null);
  } finally { global.fetch = old; }
});
