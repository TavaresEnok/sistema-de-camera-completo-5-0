import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCameraDto } from '../src/cameras/dto/create-camera.dto';
import { UpdateCameraDto } from '../src/cameras/dto/update-camera.dto';
import { CamerasService } from '../src/cameras/cameras.service';
import { CamerasController } from '../src/cameras/cameras.controller';
import { aiEnabledEfetivo } from '../src/cameras/helpers/motion-detector.helper';
import { needsSystemMotion, MOTION_NOTICE_DEMAND } from '../src/cameras/helpers/motion-notice.helper';
import { noticeClasses, noticeObjectClass } from '../src/cameras/helpers/detection-notice.helper';
import { decidirObjetoDaCamera } from '../src/ai/helpers/escopo-de-objeto.helper';
import { detectionNoticeMessage, selectMotionNotices } from '../../web/src/lib/motion-notices';

test('object notice in manual mode requires one detector even with edge motion or object never, not recording', () => {
  const c = { id: 'a', recordingMode: 'manual', motionTrigger: 'CAMERA', aiEnabled: false, objectMode: 'nunca', objectNoticeEnabled: true };
  assert.equal(aiEnabledEfetivo(c), true);
  assert.equal(needsSystemMotion(c), true);
  assert.ok(MOTION_NOTICE_DEMAND.OR.some(r => 'objectNoticeEnabled' in r));
  assert.deepEqual(decidirObjetoDaCamera({ ...c, aiEnabled: true }, { politicaLiberaObjeto: true }), { cameraId: 'a', roda: true, motivo: 'aviso-por-objeto' });
  assert.equal(decidirObjetoDaCamera({ ...c, aiEnabled: true }, { politicaLiberaObjeto: false }).roda, false);
  assert.equal(c.recordingMode, 'manual');
  assert.equal(needsSystemMotion({ ...c, objectNoticeEnabled: false }), false);
});

test('classes normalize Portuguese labels and never fall back to unselected licensed classes', () => {
  assert.equal(noticeObjectClass({ label: 'Pessoa' }), 'person');
  assert.equal(noticeObjectClass({ label: 'moto' }), 'motorcycle');
  assert.equal(noticeObjectClass({ label: 'cadeira' }), null);
  assert.deepEqual(noticeClasses(['person'], ['car']), []);
  assert.deepEqual(noticeClasses(['person'], []), ['person']);
});

function service(allowed = ['person'], objectAllowed = true) {
  const svc: any = Object.create(CamerasService.prototype);
  svc.moduleRef = { get: () => ({ getPolicy: async () => ({ aiObjectClasses: allowed }), isAllowed: async (feature: string) => feature !== 'aiObject' || objectAllowed }) };
  return svc;
}

test('notice API validates plan and does not block disable or unrelated edits', async () => {
  const svc = service();
  await svc.validateDetectionNotices({ objectNoticeEnabled: true, objectNoticeClasses: ['person'] });
  await assert.rejects(svc.validateDetectionNotices({ objectNoticeEnabled: true, objectNoticeClasses: ['car'] }));
  await assert.rejects(service([], false).validateDetectionNotices({ objectNoticeEnabled: true }));
  await service([], false).validateDetectionNotices({ objectNoticeEnabled: false }, { objectNoticeEnabled: true, objectNoticeClasses: ['car'] });
  await service([], false).validateDetectionNotices({ name: 'Portaria' }, { objectNoticeEnabled: true });
});

test('combined feed preserves permissions, freshness and exact object selection', async () => {
  const svc = service(['person', 'car']); let query: any;
  const event = { cameraId: 'allowed', occurredAt: new Date(), camera: { name: 'Portaria', objectNoticeClasses: ['person'] } };
  svc.prisma = { cameraEvent: { findMany: async (q: any) => { query = q; return [
    { ...event, id: 'person', type: 'OBJECT_DETECTED', metadata: { label: 'pessoa' } },
    { ...event, id: 'car', type: 'OBJECT_DETECTED', metadata: { label: 'carro' } },
    { ...event, id: 'motion', type: 'MOTION_DETECTED', metadata: {} },
  ]; } } };
  assert.deepEqual((await svc.listDetectionNotices(['allowed'])).items, []);
  const result = await svc.listDetectionNotices(['allowed'], new Date(Date.now() - 1000).toISOString());
  assert.deepEqual(query.where.cameraId.in, ['allowed']);
  assert.deepEqual(query.where.camera, { enabled: true });
  assert.equal(query.where.OR.length, 2);
  assert.equal(query.take, 200);
  assert.deepEqual(result.items.map((e: any) => e.id), ['person', 'motion']);
  assert.equal(result.items[0].objectClass, 'person');
  svc.access = false;
  assert.deepEqual((await svc.listDetectionNotices([], new Date().toISOString())).items, []);
});

test('combined feed respects removed object entitlement', async () => {
  const svc = service(['person'], false); let query: any;
  svc.prisma = { cameraEvent: { findMany: async (q: any) => { query = q; return []; } } };
  await svc.listDetectionNotices(['a'], new Date().toISOString());
  assert.equal(query.where.OR.length, 1);
  assert.equal(query.where.OR[0].type, 'MOTION_DETECTED');
});

test('combined endpoint only requests accessible cameras', async () => {
  const c: any = Object.create(CamerasController.prototype);
  c.accessControlService = { getAccessibleCameraIds: async () => ['shared'] };
  c.camerasService = { listDetectionNotices: async (ids: string[]) => ids };
  assert.deepEqual(await c.detectionNotices({ role: 'ADMIN' }), ['shared']);
});

test('notice DTOs require real booleans and valid bounded object classes', async () => {
  for (const C of [CreateCameraDto, UpdateCameraDto]) {
    for (const field of ['motionNoticeEnabled', 'objectNoticeEnabled']) {
      const errors = await validate(plainToInstance(C, { sourceMode: 'rtmp_push', [field]: 'false' }, { enableImplicitConversion: true }));
      assert.ok(errors.some(e => e.property === field));
    }
    const errors = await validate(plainToInstance(C, { objectNoticeClasses: ['chair'] }));
    assert.ok(errors.some(e => e.property === 'objectNoticeClasses'));
  }
});

test('notices say person or vehicle without scores, movement cannot suppress a person', () => {
  const now = Date.now(); const base = { cameraId: 'a', cameraName: 'Portaria', occurredAt: new Date(now).toISOString() };
  const motion = { ...base, id: 'm' }; const person = { ...base, id: 'p', detectionType: 'object' as const, objectClass: 'person' };
  assert.equal(detectionNoticeMessage(person), 'Portaria detectou uma pessoa.');
  assert.equal(detectionNoticeMessage({ ...person, objectClass: 'motorcycle' }), 'Portaria detectou uma moto.');
  assert.equal(detectionNoticeMessage(motion), 'Portaria detectou movimento.');
  assert.equal(selectMotionNotices([motion, person], new Set(), new Map(), now).length, 2);
});
