import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { applyCameraPrivacy, cameraPrivacyRevision, hasPrivacyFields, privateCreation, privacyGrants } from '../src/cameras/helpers/camera-privacy.helper';
import { CameraPrivacyDto } from '../src/cameras/dto/camera-privacy.dto';
import { CameraStreamController } from '../src/camera-stream/camera-stream.controller';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';

const stamp = '2026-10-08T12:00:00.000Z';
const confirmation = (isPrivate = false) => ({ privacyConfirmed: true, expectedUpdatedAt: stamp,
  expectedPrivacyRevision: cameraPrivacyRevision({ isPrivate, ownerUserId: isPrivate ? 'old' : null, updatedAt: new Date(stamp) },
    [{ userId: 'old', level: 'ADMIN' }, { userId: 'delegate', level: 'CONTROL' }]) });
function database(isPrivate = false) {
  const calls: any[] = [];
  const db: any = {
    user: { findMany: async ({ where }: any) => where.id.in.filter((id: string) => id !== 'inactive').map((id: string) => ({ id })) },
    camera: { findUniqueOrThrow: async () => ({ isPrivate, ownerUserId: isPrivate ? 'old' : null, updatedAt: new Date(stamp) }) },
    cameraPermission: {
      findMany: async () => [{ userId: 'old', level: 'ADMIN' }, { userId: 'delegate', level: 'CONTROL' }],
      deleteMany: async (args: any) => { calls.push(['delete', args]); },
      createMany: async (args: any) => { calls.push(['create', args]); },
    },
  };
  return { db, calls };
}

test('cadastro normal permanece normal e privada exige dono ativo', async () => {
  const { db } = database();
  assert.equal(hasPrivacyFields({}), false);
  assert.equal(await privateCreation(db, {}), undefined);
  assert.deepEqual(await privateCreation(db, { isPrivate: false }), { isPrivate: false, ownerUserId: null });
  await assert.rejects(() => privateCreation(db, { isPrivate: true }), BadRequestException);
  await assert.rejects(() => privateCreation(db, { isPrivate: true, ownerUserId: 'inactive' }), BadRequestException);
  await assert.rejects(() => privateCreation(db, { isPrivate: false, ownerUserId: 'old' }), BadRequestException);
});

test('dono ADMIN explícito e novos compartilhamentos somente VIEW, sem duplicar dono', async () => {
  const { db } = database();
  const result = await privateCreation(db, { isPrivate: true, ownerUserId: 'old', privateViewerIds: ['old', 'delegate'] });
  assert.deepEqual(privacyGrants(result!), [{ userId: 'old', level: 'ADMIN' }, { userId: 'delegate', level: 'VIEW' }]);
});

test('converter comum em privada remove acessos anteriores não selecionados', async () => {
  const { db, calls } = database();
  const result = await applyCameraPrivacy(db, 'cam', { ...confirmation(), isPrivate: true, ownerUserId: 'new', privateViewerIds: [] });
  assert.deepEqual(result, { isPrivate: true, ownerUserId: 'new' });
  assert.deepEqual(calls[0], ['delete', { where: { cameraId: 'cam' } }]);
  assert.deepEqual(calls[1][1].data, [{ userId: 'new', level: 'ADMIN', cameraId: 'cam' }]);
});

test('troca de proprietário revoga antigo dono e preserva nível de delegado selecionado', async () => {
  const { db, calls } = database(true);
  await applyCameraPrivacy(db, 'cam', { ...confirmation(true), ownerUserId: 'new', privateViewerIds: ['delegate'] });
  const data = calls[1][1].data;
  assert.equal(data.some((grant: any) => grant.userId === 'old'), false);
  assert.equal(data.find((grant: any) => grant.userId === 'delegate').level, 'CONTROL');
});

test('voltar ao modo comum exige confirmação e remove propriedade sem apagar arquivos', async () => {
  const { db, calls } = database(true);
  assert.deepEqual(await applyCameraPrivacy(db, 'cam', { ...confirmation(true), isPrivate: false }), { isPrivate: false, ownerUserId: null });
  assert.deepEqual(calls, [['delete', { where: { cameraId: 'cam', userId: 'old' } }]]);
});

test('sem confirmação, revisão ou com usuário inválido nenhuma concessão é alterada', async () => {
  const { db, calls } = database();
  await assert.rejects(() => applyCameraPrivacy(db, 'cam', { isPrivate: true, ownerUserId: 'new' }), BadRequestException);
  await assert.rejects(() => applyCameraPrivacy(db, 'cam', { ...confirmation(), isPrivate: true, ownerUserId: 'new', expectedUpdatedAt: '2026-10-08T11:00:00Z' }), ConflictException);
  await assert.rejects(() => applyCameraPrivacy(db, 'cam', { ...confirmation(), isPrivate: true, ownerUserId: 'new', privateViewerIds: ['inactive'] }), BadRequestException);
  await assert.rejects(() => applyCameraPrivacy(db, 'cam', { ...confirmation(), isPrivate: true, ownerUserId: 'new', expectedPrivacyRevision: 'a'.repeat(64) }), ConflictException);
  assert.equal(calls.length, 0);
});

test('validação não converte string false/true nem null em booleano de privacidade', async () => {
  for (const isPrivate of ['false', 'true', null, 1]) {
    const dto = plainToInstance(CameraPrivacyDto, { isPrivate }, { enableImplicitConversion: true });
    assert.ok((await validate(dto)).length, String(isPrivate));
  }
  assert.equal((await validate(plainToInstance(CameraPrivacyDto, { isPrivate: false }))).length, 0);
});

test('token de vídeo emitido antes da privacidade não contorna ACL atual', async () => {
  const cameraId = '11111111-1111-4111-8111-111111111111';
  let allowed = true;
  const controller = new CameraStreamController(null as any, null as any, null as any,
    { findOneInternal: async () => ({ enabled: true }) } as any,
    { verifyStreamToken: async () => ({ cameraId, sub: 'viewer' }), me: async () => ({ id: 'viewer' }) } as any,
    { assertCanViewCamera: async () => { if (!allowed) throw new ForbiddenException(); } } as any,
    null as any, null as any, null as any, { get: (key: string) => key === 'mediaMtxAuthCallbackToken' ? 'x'.repeat(48) : '' } as any, null as any);
  const invoke = async () => {
    let status = 0;
    const res: any = { status(code: number) { status = code; return res; }, json() { return res; } };
    await controller.authorizeMediaMtx({ action: 'read', token: 'old-signed-token', path: 'cam_' + cameraId.replaceAll('-', '') }, 'x'.repeat(48), res);
    return status;
  };
  assert.equal(await invoke(), 200);
  allowed = false;
  assert.equal(await invoke(), 401);
});

test('revogação atinge apenas leitores de câmera escolhida, não publisher nem source', async () => {
  const service: any = Object.create(MediamtxProxyService.prototype);
  const calls: string[] = [];
  service.isEnabled = () => true;
  service.getRuntimePathItems = async () => [
    { name: 'cam_abc_grid', readers: [{ type: 'webRTCSession', id: 'viewer' }, { type: 'rtspSession', id: 'rtsp' }] },
    { name: 'cam_abc_source', readers: [{ type: 'rtspSession', id: 'source' }] },
    { name: 'cam_other', readers: [{ type: 'webRTCSession', id: 'other' }] },
    { name: 'drac/ingest', readers: [{ type: 'rtmpConn', id: 'push' }] },
  ];
  service.apiRequest = async (_method: string, route: string) => { calls.push(route); };
  assert.deepEqual(await service.revokeCameraViewers('abc'), { complete: true });
  assert.deepEqual(calls, ['/v3/webrtcsessions/kick/viewer', '/v3/rtspsessions/kick/rtsp']);
});
