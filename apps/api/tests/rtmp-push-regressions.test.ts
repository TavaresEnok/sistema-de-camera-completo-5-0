import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { CamerasService } from '../src/cameras/cameras.service';
import { ClipCaptureService } from '../src/camera-stream/clip-capture.service';
import { FfmpegMjpegService } from '../src/camera-stream/ffmpeg-mjpeg.service';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';
import { RtmpIngestSourceService } from '../src/cameras/rtmp-ingest-source.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { generateIngestKey } from '../src/cameras/helpers/rtmp-ingest.helper';
import type { AuthUser } from '../src/common/types/auth-user.type';
import { UserRole } from '@prisma/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('botão Gravar usa a publicação interna da RTMP e nunca tenta 0.0.0.0', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rtmp-clip-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let decryptCalls = 0;
  const resolveCalls: any[] = [];
  const service = new ClipCaptureService(
    { get: (key: string) => key === 'recordingsRoot' ? root : undefined } as any,
    {} as any,
    { decrypt: () => { decryptCalls += 1; throw new Error('não deveria descriptografar RTMP'); } } as any,
    {
      resolve: async (camera: any, options: any) => {
        resolveCalls.push({ camera, options });
        return {
          sourceUrl: 'rtsp://internal-user:internal-pass@mediamtx:8554/d/abcdefghijklmnopqrstuv',
        };
      },
    } as any,
  );

  const input = await (service as any).resolveClipInput({
    id: 'push-clip-1',
    sourceMode: 'rtmp_push',
    ip: '0.0.0.0',
    passwordEncrypted: 'marcador-cifrado',
  });

  assert.equal(decryptCalls, 0);
  assert.equal(resolveCalls.length, 1);
  assert.deepEqual(resolveCalls[0].options, { requireReady: true });
  assert.equal(input.transport, 'tcp');
  assert.equal(input.url.includes('0.0.0.0'), false);
  assert.match(input.url, /^rtsp:\/\/.*@mediamtx:8554\//);
});

test('RTMP administrativa ignora payload contínuo e nasce manual/desligada', async () => {
  let written: any = null;
  const service = Object.create(CamerasService.prototype) as any;
  service.validateReferences = async () => undefined;
  service.getDefaultRetentionDays = () => 7;
  service.cryptoService = { encrypt: (value: string) => `encrypted:${value}` };
  service.configService = { get: () => '' };
  service.logger = { log() {} };
  service.prisma = {
    camera: {
      create: async ({ data }: any) => {
        written = data;
        return { id: 'push-admin-1', createdAt: new Date(), updatedAt: new Date(), ...data };
      },
    },
  };

  await service.create({
    name: 'Entrada RTMP',
    sourceMode: 'rtmp_push',
    recordingMode: 'continuous',
    recordingEnabled: true,
  });

  assert.equal(written.recordingMode, 'manual');
  assert.equal(written.recordingEnabled, false);
  assert.equal(written.recordingVideoCodec, 'original');
  assert.equal(written.audioEnabled, true, 'RTMP nova preserva áudio para a live');
});

test('RTMP privada criada pelo app nasce manual, desligada e herda 3 dias do grupo', async () => {
  const writes: any[] = [];
  const owner: AuthUser = {
    id: 'cliente-1',
    email: 'cliente@example.test',
    name: 'Cliente',
    role: UserRole.VIEWER,
  };
  const service = Object.create(CamerasService.prototype) as any;
  service.vinculosDeGrupo = async () => [{
    groupId: 'grupo-3-dias',
    level: 'CONTROL',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }];
  service.getPrivateCameraQuota = async () => ({ used: 0, limit: 2 });
  service.prisma = {
    cameraGroup: {
      findUnique: async () => ({ retentionDays: 3 }),
    },
    cameraPermission: {
      create: async () => ({ id: 'permissao-1' }),
    },
  };
  service.create = async (dto: any, privacy: any) => {
    writes.push({ dto, privacy });
    return { id: 'camera-1', ...dto };
  };

  await service.createPrivateForOwner({
    name: 'Câmera do cliente',
    sourceMode: 'rtmp_push',
    recordingMode: 'continuous',
    recordingEnabled: true,
    retentionDays: 99,
    retentionFollowsGroup: false,
    motionTrigger: 'CAMERA',
    aiEnabled: false,
  }, owner);

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].privacy, { isPrivate: true, ownerUserId: owner.id });
  assert.equal(writes[0].dto.groupId, 'grupo-3-dias');
  assert.equal(writes[0].dto.recordingMode, 'manual');
  assert.equal(writes[0].dto.recordingEnabled, false);
  assert.equal(writes[0].dto.motionTrigger, 'SYSTEM');
  assert.equal(writes[0].dto.aiEnabled, false);
  assert.equal(writes[0].dto.retentionDays, 3);
  assert.equal(writes[0].dto.retentionFollowsGroup, true);
  assert.equal(writes[0].dto.recordingVideoCodec, 'original');
});

test('RTMP privada sem grupo recebe retenção própria padrão de 3 dias', async () => {
  let written: any = null;
  const owner: AuthUser = {
    id: 'cliente-sem-grupo',
    email: 'sem-grupo@example.test',
    name: 'Cliente sem grupo',
    role: UserRole.VIEWER,
  };
  const service = Object.create(CamerasService.prototype) as any;
  service.vinculosDeGrupo = async () => [];
  service.getPrivateCameraQuota = async () => ({ used: 0, limit: 1 });
  service.prisma = {
    cameraGroup: { findUnique: async () => { throw new Error('não deve consultar sem grupo'); } },
    cameraPermission: { create: async () => ({}) },
  };
  service.create = async (dto: any) => {
    written = dto;
    return { id: 'camera-sem-grupo', ...dto };
  };

  await service.createPrivateForOwner({
    name: 'Câmera sem grupo',
    sourceMode: 'rtmp_push',
    recordingMode: 'continuous',
    retentionDays: 365,
  }, owner);

  assert.equal(written.recordingMode, 'manual');
  assert.equal(written.recordingEnabled, false);
  assert.equal(written.retentionDays, 3);
  assert.equal(written.retentionFollowsGroup, false);
  assert.equal(written.recordingVideoCodec, 'original');
});

test('poster de câmera RTMP offline não tenta RTSP direto nem descriptografa marcador', async () => {
  let decryptCalls = 0;
  const service = new FfmpegMjpegService(
    { get: () => undefined } as any,
    { getCameraOrThrow: async () => ({ id: 'push-1', sourceMode: 'rtmp_push' }) } as any,
    { decrypt: () => { decryptCalls += 1; throw new Error('não deveria descriptografar'); } } as any,
    { resolveGridPosterSource: async () => { throw new Error('ainda sem publicação'); } } as any,
  );
  (service as any).checkFfmpegAvailable = () => true;
  (service as any).logger = { debug() {} };

  await assert.rejects(
    () => (service as any).generateLivePosterFrame('push-1'),
    (error: unknown) => error instanceof ServiceUnavailableException
      && error.message === 'Câmera RTMP ainda não está publicando vídeo.',
  );
  assert.equal(decryptCalls, 0);
});

test('poster de câmera RTMP publicada usa o stream interno, não o IP marcador', async () => {
  let decryptCalls = 0;
  let gridCalls = 0;
  const proxy = Object.create(MediamtxProxyService.prototype) as any;
  proxy.camerasService = {
    getCameraOrThrow: async () => ({
      id: 'push-poster-1', sourceMode: 'rtmp_push', enabled: true,
      ip: '0.0.0.0', passwordEncrypted: 'marcador', preferredRtspTransport: 'tcp',
    }),
  };
  proxy.configService = { get: () => 'tcp' };
  proxy.cryptoService = { decrypt: () => { decryptCalls += 1; throw new Error('marcador não pode ser lido'); } };
  proxy.chooseGridSource = async () => { gridCalls += 1; throw new Error('não deve consultar RTSP da câmera'); };
  proxy.resolvePushLiveSource = async () => ({
    sourceUrl: 'rtsp://media-interno/cam_publicada', profile: null, isHevc: false,
  });

  const selected = await proxy.resolveGridPosterSource('push-poster-1');
  assert.equal(selected.sourceUrl, 'rtsp://media-interno/cam_publicada');
  assert.equal(selected.sourceVideoCodec, 'h264');
  assert.equal(selected.usedSubStream, false);
  assert.equal(decryptCalls, 0);
  assert.equal(gridCalls, 0);
});

test('entrada RTMP recém-publicada aguarda a propagação curta do MediaMTX antes de declarar sem vídeo', async () => {
  const service = new RtmpIngestSourceService(
    {
      get: (key: string) => ({
        mediaMtxApiUser: 'internal',
        mediaMtxApiPass: 'internal',
        mediaMtxRtspInternalUrl: 'rtsp://mediamtx:8554',
      })[key],
    } as any,
    { decrypt: () => { throw new Error('não deve precisar da chave quando há path'); } } as any,
  );
  let reads = 0;
  (service as any).getRuntime = async () => {
    reads += 1;
    return reads === 1
      ? { ready: false, stalled: false, bytesReceived: null, tracks: [], codec: null, bitrateKbps: null }
      : { ready: true, stalled: false, bytesReceived: 1200, tracks: ['H264'], codec: 'h264', bitrateKbps: null };
  };

  const resolved = await service.resolve({ rtmpIngestPath: 'd/camera-recente' }, { requireReady: true });
  assert.equal(resolved.pathName, 'd/camera-recente');
  assert.equal(resolved.ready, true);
  assert.equal(resolved.sourceUrl.includes('mediamtx:8554'), true);
  assert.equal(reads, 2, 'deve reconsultar a publicação antes de falhar');
});

test('RTMP usa o secundário quando é o único perfil que publica', async () => {
  const service = new RtmpIngestSourceService(
    {
      get: (key: string) => ({
        mediaMtxApiUser: 'internal',
        mediaMtxApiPass: 'internal',
        mediaMtxRtspInternalUrl: 'rtsp://mediamtx:8554',
      })[key],
    } as any,
    { decrypt: () => { throw new Error('path aprendido não usa chave'); } } as any,
  );
  const reads: string[] = [];
  (service as any).getRuntime = async (pathName: string) => {
    reads.push(pathName);
    return pathName.endsWith('_0_1')
      ? { ready: true, stalled: false, bytesReceived: 1200, tracks: ['H264'], codec: 'h264', bitrateKbps: 700 }
      : { ready: false, stalled: false, bytesReceived: null, tracks: [], codec: null, bitrateKbps: null };
  };

  const resolved = await service.resolve({
    rtmpIngestPath: 'live/liveStream_DHK0003252944_0_1',
  }, { requireReady: true });

  assert.deepEqual(reads, [
    'live/liveStream_DHK0003252944_0_0',
    'live/liveStream_DHK0003252944_0_1',
  ]);
  assert.equal(resolved.pathName, 'live/liveStream_DHK0003252944_0_1');
  assert.equal(resolved.ready, true);
});

test('RTMP promove o principal quando os dois perfis estão disponíveis', async () => {
  const service = new RtmpIngestSourceService(
    {
      get: (key: string) => ({
        mediaMtxApiUser: 'internal',
        mediaMtxApiPass: 'internal',
        mediaMtxRtspInternalUrl: 'rtsp://mediamtx:8554',
      })[key],
    } as any,
    { decrypt: () => { throw new Error('path aprendido não usa chave'); } } as any,
  );
  const reads: string[] = [];
  (service as any).getRuntime = async (pathName: string) => {
    reads.push(pathName);
    return { ready: true, stalled: false, bytesReceived: 5000, tracks: ['H264'], codec: 'h264', bitrateKbps: 2000 };
  };

  const resolved = await service.resolve({
    rtmpIngestPath: 'live/liveStream_DHK0003252944_0_1',
  }, { requireReady: true });

  assert.deepEqual(reads, ['live/liveStream_DHK0003252944_0_0']);
  assert.equal(resolved.pathName, 'live/liveStream_DHK0003252944_0_0');
});

test('RTMP abandona o principal parado e mantém o secundário vivo', async () => {
  const service = new RtmpIngestSourceService(
    {
      get: (key: string) => ({
        mediaMtxApiUser: 'internal',
        mediaMtxApiPass: 'internal',
        mediaMtxRtspInternalUrl: 'rtsp://mediamtx:8554',
      })[key],
    } as any,
    { decrypt: () => { throw new Error('path aprendido não usa chave'); } } as any,
  );
  (service as any).getRuntime = async (pathName: string) => pathName.endsWith('_0_0')
    ? { ready: true, stalled: true, bytesReceived: 5000, tracks: ['H264'], codec: 'h264', bitrateKbps: 0 }
    : { ready: true, stalled: false, bytesReceived: 7000, tracks: ['H264'], codec: 'h264', bitrateKbps: 700 };

  const resolved = await service.resolve({
    rtmpIngestPath: 'live/liveStream_DHK0003252944_0_0',
  }, { requireReady: true });

  assert.equal(resolved.pathName, 'live/liveStream_DHK0003252944_0_1');
  assert.equal(resolved.stalled, false);
});

test('autorização por path aceita perfil irmão, mas nega família ambígua', async () => {
  const service = Object.create(CamerasService.prototype) as any;
  let queriedPaths: string[] = [];
  service.prisma = {
    camera: {
      findMany: async ({ where }: any) => {
        queriedPaths = where.rtmpIngestPath.in;
        return [{ id: 'camera-1', name: 'Recepção', enabled: true, sourceMode: 'rtmp_push' }];
      },
    },
  };

  const camera = await service.findCameraByIngestPath('live/liveStream_DHK0003252944_0_0');
  assert.equal(camera.id, 'camera-1');
  assert.deepEqual(queriedPaths, [
    'live/liveStream_DHK0003252944_0_0',
    'live/liveStream_DHK0003252944_0_1',
  ]);

  service.prisma.camera.findMany = async () => [
    { id: 'camera-1', name: 'Recepção', enabled: true, sourceMode: 'rtmp_push' },
    { id: 'camera-2', name: 'Garagem', enabled: true, sourceMode: 'rtmp_push' },
  ];
  assert.equal(
    await service.findCameraByIngestPath('live/liveStream_DHK0003252944_0_1'),
    null,
    'dois donos diferentes precisam falhar fechados',
  );
});

test('edição de câmera RTMP ignora o marcador de rede sem afrouxar câmera RTSP', async () => {
  const existing = {
    id: 'push-1',
    name: 'Portaria',
    ip: '0.0.0.0',
    rtspPort: 554,
    onvifPort: null,
    sourceMode: 'rtmp_push',
    passwordEncrypted: 'encrypted-empty',
    enabled: true,
    recordingEnabled: false,
    recordingMode: 'manual',
    alarmsEnabled: true,
    hasEdgeAi: false,
    motionTrigger: 'SYSTEM',
  };
  const writes: any[] = [];
  let networkPolicyCalls = 0;
  const service = Object.create(CamerasService.prototype) as any;
  service.getCameraOrThrow = async () => existing;
  service.assertTestTargetAllowed = () => { networkPolicyCalls += 1; throw new Error('marcador não é destino'); };
  service.validateReferences = async () => undefined;
  service.normalizeProfileToDetected = () => ({
    streamWidth: undefined,
    streamHeight: undefined,
    streamFps: undefined,
    streamBitrateKbps: undefined,
    recordingWidth: undefined,
    recordingHeight: undefined,
    recordingFps: undefined,
    recordingBitrateKbps: undefined,
  });
  service.normalizeLiveProtocol = () => 'webrtc';
  service.cryptoService = { encrypt: () => 'encrypted' };
  service.prisma = {
    camera: {
      update: async (input: any) => {
        writes.push(input);
        return { ...existing, ...input.data, ip: existing.ip };
      },
    },
  };

  await service.update('push-1', {
    name: 'Portaria atualizada',
    ip: '0.0.0.0',
    rtspPort: 554,
    username: '',
    rtspPath: '',
    recordingMode: 'manual',
    retentionDays: 7,
    preferredRtspTransport: 'tcp',
    preferredLiveProtocol: 'webrtc',
    streamVideoCodec: 'h264',
    recordingVideoCodec: 'h264',
    audioEnabled: false,
    aiEnabled: false,
    alarmsEnabled: true,
    enabled: true,
  });

  assert.equal(networkPolicyCalls, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.ip, undefined);
  assert.equal(writes[0].data.name, 'Portaria atualizada');
  assert.equal(writes[0].data.recordingVideoCodec, 'h264');

  service.getCameraOrThrow = async () => ({
    ...existing,
    sourceMode: 'rtsp_pull',
    ip: '192.168.1.20',
    httpPort: 80,
  });
  service.assertTestTargetAllowed = (ip: string) => {
    networkPolicyCalls += 1;
    return ip;
  };
  await service.update('pull-1', { name: 'RTSP validada' });
  assert.equal(networkPolicyCalls, 2, 'câmera RTSP deve validar as portas de vídeo e acesso web');
});

test('caminho por serial não esconde a URL personalizada compatível', async () => {
  const key = generateIngestKey();
  const service = Object.create(CamerasService.prototype) as any;
  service.prisma = {
    camera: {
      findUnique: async () => ({
        sourceMode: 'rtmp_push',
        rtmpIngestKeyEncrypted: 'chave-cifrada',
        rtmpIngestPath: 'live/liveStream_H3ZL2802830WB_0_0',
      }),
    },
  };
  service.cryptoService = { decrypt: () => key };
  service.configService = {
    get: (name: string) => name === 'mediaMtxPublicHost'
      ? 'ajustcam.example.test'
      : name === 'mediaMtxRtmpShortHost'
        ? '192.0.2.25'
        : undefined,
  };

  const target = await service.getRtmpIngestTarget('camera-1');

  assert.equal(target.ingestPath, 'live/liveStream_H3ZL2802830WB_0_0');
  assert.match(target.fullUrl, /^rtmp:\/\/192\.0\.2\.25:1935\/d\/[A-Za-z0-9_-]{22}$/);
  assert.equal(target.serverUrl, 'rtmp://192.0.2.25:1935/drac');
});

test('filtro HTTP redige token tanto no log quanto na resposta de erro', () => {
  const secret = 'valor-que-nao-pode-aparecer';
  const logs: string[] = [];
  let body: any = null;
  const response = {
    status() { return response; },
    json(value: unknown) { body = value; return response; },
  };
  const filter = new HttpExceptionFilter();
  (filter as any).logger = {
    error: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(message),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        method: 'GET',
        url: `/camera-stream/cam/poster?token=${secret}&v=1`,
        headers: {},
      }),
    }),
  };

  filter.catch(new ServiceUnavailableException('offline'), host as any);

  assert.equal(String(body?.path).includes(secret), false);
  assert.equal(logs.join('\n').includes(secret), false);
  assert.match(String(body?.path), /token=<redacted>/);
});
