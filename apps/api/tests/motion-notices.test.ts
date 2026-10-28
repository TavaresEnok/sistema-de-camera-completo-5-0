import assert from 'node:assert/strict';
import test from 'node:test';
import { aiEnabledEfetivo } from '../src/cameras/helpers/motion-detector.helper';
import { needsSystemMotion } from '../src/cameras/helpers/motion-notice.helper';
import { CamerasService } from '../src/cameras/cameras.service';
import { CamerasController } from '../src/cameras/cameras.controller';
import { selectMotionNotices } from '../../web/src/lib/motion-notices';

test('manual notices require the detector, never change recording mode', () => {
  const camera = { recordingMode: 'manual', motionTrigger: 'CAMERA', aiEnabled: false, motionNoticeEnabled: true };
  assert.equal(aiEnabledEfetivo(camera), true);
  assert.equal(needsSystemMotion(camera), true);
  assert.equal(camera.recordingMode, 'manual');
  assert.equal(needsSystemMotion({ ...camera, motionNoticeEnabled: false }), false);
  assert.equal(needsSystemMotion({ recordingMode: 'motion', motionTrigger: 'SYSTEM' }), true);
  assert.equal(needsSystemMotion({ recordingMode: 'object', motionTrigger: 'SYSTEM' }), true);
});

test('first request or invalid cursor does not replay past movements', async () => {
  const svc: any = Object.create(CamerasService.prototype);
  svc.prisma = { cameraEvent: { findMany: () => { throw Error('must not query history'); } } };
  for (const since of [undefined, 'not-a-date', new Date(Date.now() + 100000).toISOString()]) {
    const x = await svc.listMotionNotices(['a'], since);
    assert.deepEqual(x.items, []);
    assert.ok(Number.isFinite(Date.parse(x.cursor)));
  }
});

test('legacy motion feed delegates permission, licensing, freshness and perimeter checks', async () => {
  const svc: any = Object.create(CamerasService.prototype);
  svc.listDetectionNotices = async (ids: string[], since: string) => {
    assert.deepEqual(ids,['allowed']); assert.equal(since,'2000-01-01T00:00:00Z');
    return {items:[{id:'motion',detectionType:'motion'},{id:'person',detectionType:'object'}],cursor:'now'};
  };
  assert.deepEqual((await svc.listMotionNotices(['allowed'],'2000-01-01T00:00:00Z')).items.map((item:any)=>item.id),['motion']);
});

test('controller uses content access even for admin (private cameras stay private)', async () => {
  const c: any = Object.create(CamerasController.prototype);
  c.accessControlService = { getAccessibleCameraIds: async (u: any) => { assert.equal(u.role, 'ADMIN'); return ['shared']; } };
  c.camerasService = { listMotionNotices: async (ids: string[]) => ids };
  assert.deepEqual(await c.motionNotices({ role: 'ADMIN', id: 'admin' }), ['shared']);
});

test('UI deduplicates overlapping polls and limits a camera to one notice per 30s', () => {
  const seen = new Set<string>(); const cameras = new Map<string, number>(); const now = Date.now();
  const event = { id: 'one', cameraId: 'a', cameraName: 'Portaria', occurredAt: new Date(now).toISOString() };
  assert.equal(selectMotionNotices([event], seen, cameras, now).length, 1);
  assert.equal(selectMotionNotices([event], seen, cameras, now).length, 0);
  assert.equal(selectMotionNotices([{ ...event, id: 'two' }], seen, cameras, now + 1000).length, 0);
  assert.equal(selectMotionNotices([{ ...event, id: 'three', occurredAt: new Date(now + 31000).toISOString() }], seen, cameras, now + 31000).length, 1);
});

test('UI ignores stale/invalid movements and bounds memory and visible notices', () => {
  const now = Date.now(); const seen = new Set<string>(); const cameras = new Map<string, number>();
  const items = Array.from({ length: 1200 }, (_, n) => ({ id: String(n), cameraId: String(n), cameraName: 'Cam', occurredAt: new Date(now).toISOString() }));
  assert.equal(selectMotionNotices(items, seen, cameras, now).length, 3);
  assert.equal(seen.size, 1000);
  assert.equal(selectMotionNotices([{ id: 'old', cameraId: 'old', cameraName: 'Cam', occurredAt: new Date(now - 60000).toISOString() }], seen, cameras, now).length, 0);
});
