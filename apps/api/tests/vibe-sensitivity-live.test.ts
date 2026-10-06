import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateCameraDto } from '../src/cameras/dto/update-camera.dto';
import { CreateCameraDto } from '../src/cameras/dto/create-camera.dto';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';
import { CameraStreamController } from '../src/camera-stream/camera-stream.controller';
import { LiveCapacityException } from '../src/camera-stream/helpers/live-capacity.helper';

test('camera sensitivity accepts only real presets in both DTOs', () => {
  for (const dto of [CreateCameraDto, UpdateCameraDto]) {
    for (const level of ['baixa', 'media', 'alta']) {
      const errors = validateSync(plainToInstance(dto as any, { motionSensitivity: level }));
      assert.equal(errors.some(error => error.property === 'motionSensitivity'), false);
    }
    assert.equal(validateSync(plainToInstance(dto as any, { motionSensitivity: 'invalid' }))
      .some(error => error.property === 'motionSensitivity'), true);
  }
});

function proxy(width = 1920, height = 1080) {
  const service: any = new MediamtxProxyService({ get: () => undefined } as any, {} as any, {} as any, {} as any);
  service.logger = { error() {}, warn() {}, log() {}, debug() {} };
  service.usePrivateSourceHop = false;
  service.maxTranscodePoints = 4;
  service.resolvePushLiveSource = async () => ({
    profile: null, sourceUrl: 'rtsp://mediamtx:8554/fixture', codec: 'h264',
    width, height, fps: 20, bitrateKbps: 1000, isHevc: false, requiresSanitization: false, audioCodec: 'none',
  });
  service.getPath = async () => { throw { status: 404 }; };
  service.getRuntimePathItems = async () => [];
  service.apiRequest = async () => '{}';
  return service;
}

const camera = (id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') => ({ id, sourceMode: 'rtmp_push', liveChannel: 1, liveSubtype: 0 });

test('large grid is downscaled, original and small grid remain copy', async () => {
  const previous = process.env.MEDIAMTX_LIGHT_GRID_ENABLED;
  process.env.MEDIAMTX_LIGHT_GRID_ENABLED = 'true';
  try {
    const service = proxy();
    const grid = await service.configureResolvedPathForCamera(camera(), 'grid');
    assert.equal(grid.videoEncoded, true);
    assert.equal(service.isOptionalLightGridPath(grid.pathName), true);
    const original = await service.configureResolvedPathForCamera(camera(), 'original');
    assert.equal(original.videoEncoded, false);
    const small = proxy(640, 360);
    assert.equal((await small.configureResolvedPathForCamera(camera(), 'grid')).videoEncoded, false);
  } finally {
    if (previous === undefined) delete process.env.MEDIAMTX_LIGHT_GRID_ENABLED;
    else process.env.MEDIAMTX_LIGHT_GRID_ENABLED = previous;
  }
});

test('optional grid respects budget and passthrough fallback needs no encoder', async () => {
  process.env.MEDIAMTX_LIGHT_GRID_ENABLED = 'true';
  try {
    const service = proxy();
    const first = await service.configureResolvedPathForCamera(camera(), 'grid');
    await service.assertDeliveryCapacity(first.pathName);
    const secondCamera = camera('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    const second = await service.configureResolvedPathForCamera(secondCamera, 'grid');
    await assert.rejects(() => service.assertDeliveryCapacity(second.pathName), LiveCapacityException);
    const fallback = await service.configureResolvedPathForCamera(secondCamera, 'grid-hevc');
    assert.equal(fallback.videoEncoded, false);
    await service.assertDeliveryCapacity(fallback.pathName);
  } finally { delete process.env.MEDIAMTX_LIGHT_GRID_ENABLED; }
});

test('existing viewer is never disconnected to introduce optional grid optimization', async () => {
  process.env.MEDIAMTX_LIGHT_GRID_ENABLED = 'true';
  try {
    const service = proxy();
    let mutations = 0;
    service.getPath = async () => ({ source: 'rtsp://mediamtx:8554/fixture' });
    service.apiRequest = async (method: string) => {
      if (method !== 'GET') mutations++;
      return JSON.stringify({ ready: true, readers: [{ type: 'webRTCSession' }] });
    };
    const result = await service.configureResolvedPathForCamera(camera(), 'grid');
    assert.equal(result.videoEncoded, false);
    assert.equal(mutations, 0);
    assert.equal(service.capacityBudget.costFor(result.pathName), 0);
  } finally { delete process.env.MEDIAMTX_LIGHT_GRID_ENABLED; }
});

test('receiver telemetry is numeric only, rate limited and access controlled', async () => {
  let allowed = true;
  const access: any = { assertCanViewCamera: async () => { if (!allowed) throw Error('denied'); } };
  const advisor: any = { getCameraReport: async () => ({ cameraId: 'fixture' }) };
  const controller: any = new CameraStreamController({} as any, {} as any, {} as any, {} as any, {} as any,
    access, {} as any, {} as any, advisor, {} as any, {} as any);
  const user = { id: 'fixture-user' };
  assert.equal((await controller.recordLiveQuality(user, 'fixture', { receivedFps: 20, decodedFps: 19, width: 640, password: 'ignored', sdp: 'ignored' })).accepted, true);
  assert.equal((await controller.recordLiveQuality(user, 'fixture', { receivedFps: 1 })).accepted, false);
  const report = await controller.getCameraResourceDiagnostics(user, 'fixture');
  assert.equal(report.receivers[0].receivedFps, 20);
  assert.equal('password' in report.receivers[0], false);
  assert.equal('sdp' in report.receivers[0], false);
  allowed = false;
  await assert.rejects(() => controller.recordLiveQuality(user, 'fixture', { receivedFps: 1 }), /denied/);
});
