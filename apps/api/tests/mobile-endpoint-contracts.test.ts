import assert from 'node:assert/strict';
import test from 'node:test';
import { FfmpegMjpegService } from '../src/camera-stream/ffmpeg-mjpeg.service';
import { AlarmsService } from '../src/alarms/alarms.service';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { CameraStreamController } from '../src/camera-stream/camera-stream.controller';

test('disabled cameras receive neither poster tokens nor cached/live poster requests', async () => {
  const controller: any = Object.create(CameraStreamController.prototype);
  let tokens = 0;
  let captures = 0;
  controller.commercialPolicy = { assertFeature: async () => {} };
  controller.accessControlService = { assertCanViewCamera: async () => {} };
  controller.camerasService = { findOneInternal: async () => ({ enabled: false }) };
  controller.resolveApiPublicBase = () => 'https://fixture.invalid';
  controller.authService = {
    createStreamToken: async () => { tokens++; return { streamToken: 'token' }; },
    verifyStreamToken: async () => ({ cameraId: 'disabled', sub: 'user' }), me: async () => ({ id: 'user' }),
  };
  controller.ffmpegMjpegService = { getLivePosterFrame: async () => { captures++; } };
  assert.deepEqual(await controller.getPosterTokens({ id: 'user' }, { cameraIds: ['disabled'] }, {}), { items: [] });
  await assert.rejects(controller.getPoster('disabled', 'token', { headers: {} }, {}), /indisponível/);
  assert.equal(tokens, 0);
  assert.equal(captures, 0);
});

test('captura atual recusa fallback antigo mesmo quando há refresh compartilhado', async () => {
  const service = Object.create(FfmpegMjpegService.prototype) as any;
  service.refreshLivePoster = async () => ({ source: 'live', generatedAt: Date.now() - 86400000 });
  await assert.rejects(service.getLivePosterFrame('camera', true, true), /imagem atual/);
  service.refreshLivePoster = async () => ({ source: 'recording', generatedAt: Date.now() });
  await assert.rejects(service.getLivePosterFrame('camera', true, true), /imagem atual/);
  service.refreshLivePoster = async () => ({ source: 'live', generatedAt: Date.now() });
  assert.equal((await service.getLivePosterFrame('camera', true, true)).source, 'live');
});

test('sem câmeras acessíveis, alarmes não viram consulta global; filtro precede paginação', async () => {
  let query: any;
  const service = Object.create(AlarmsService.prototype) as any;
  service.prisma = { alarmInstance: {
    findMany: async (args: any) => { query = args; return []; }, count: async () => 0,
  } };
  const result = await service.list({ accessibleCameraIds: [], customerEvents: true, limit: 100 });
  assert.deepEqual(query.where.cameraId, { in: [] });
  assert.ok(query.where.NOT.length > 0);
  assert.equal(result.openTotal, 0);
});

test('mute exige acesso e booleano válido antes de persistir', async () => {
  let writes = 0;
  const controller = new NotificationsController({ setMute: async () => { writes++; } } as any,
    { assertCanViewCamera: async () => { throw new Error('denied'); } } as any);
  await assert.rejects(controller.setMute({ id: 'user' } as any, 'other-camera', { muted: true }), /denied/);
  assert.equal(writes, 0);
  const allowed = new NotificationsController({ setMute: async () => { writes++; } } as any,
    { assertCanViewCamera: async () => undefined } as any);
  await assert.rejects(allowed.setMute({ id: 'user' } as any, 'camera', { muted: 'false' } as any));
  assert.equal(writes, 0);
});
