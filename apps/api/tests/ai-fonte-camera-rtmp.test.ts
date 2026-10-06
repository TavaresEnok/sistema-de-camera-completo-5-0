import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiManagerService } from '../src/ai/ai-manager.service';

// Incidente Vibe (18/09/2026): as 3 câmeras em gravação por movimento eram
// RTMP (ip 0.0.0.0) e TODAS falhavam com "Destino de câmera bloqueado pela
// política de rede". O código já sabia usar o caminho interno do MediaMTX para
// câmera que empurra vídeo — só que a montagem da URL direta vinha ANTES do
// desvio, e `assertCameraTargetAllowed` recusa 0.0.0.0 como destino. Resultado:
// detector cego o dia inteiro e gravação de emergência assumindo (698 trechos
// em 24 h numa única câmera).

function servicoComStubs() {
  const svc: any = Object.create(AiManagerService.prototype);
  svc.logger = { log() {}, warn() {}, error() {}, debug() {} };
  svc.cryptoService = { decrypt: () => 'senha-decifrada' };
  svc.commercialPolicy = { getPolicy: async () => ({ aiObjectClasses: [] }) };
  svc.mediamtxProxy = {
    ensurePathForCamera: async (cameraId: string, mode: string) => ({
      pathName: `cam_${cameraId}_${mode === 'original' ? 'orig' : 'grid'}`,
      sourceVideoCodec: 'h264',
      transcodedForLive: false,
    }),
    buildInternalRtspUrl: (pathName: string) => `rtsp://mediamtx:8554/${pathName}`,
    probeStreamVideoCodec: async () => 'h264',
  };
  svc.carregarFontesForcadas = async () => undefined;
  svc.fontesForcadasInternas = new Set<string>();
  return svc;
}

const CAMERA_RTMP = {
  id: 'cam-rtmp',
  name: 'VIBE NOBRE LATERAL',
  // É assim que a câmera que empurra vídeo fica no cadastro: sem endereço.
  ip: '0.0.0.0',
  rtspPort: 554,
  rtspPath: '',
  username: 'admin',
  passwordEncrypted: 'x',
  sourceMode: 'rtmp_push',
  detectionZones: [],
};

test('câmera RTMP é analisada pelo caminho interno do MediaMTX, não pelo endereço dela', async () => {
  const svc = servicoComStubs();
  const fonte = await svc.buildAiSource({ ...CAMERA_RTMP });

  assert.match(
    fonte.rtspUrl,
    /^rtsp:\/\/mediamtx:8554\/cam_cam-rtmp_orig$/,
    'a análise precisa ler a publicação já recebida, não discar 0.0.0.0',
  );
  assert.equal(fonte.info.sourceKind, 'mediamtx_rtmp_push');
  assert.equal(fonte.info.usesMediaMtx, true);
  assert.ok(
    !String(fonte.info.analyticsRtspUrl ?? '').includes('0.0.0.0'),
    'o endereço inválido não pode vazar para o ai-service',
  );
});

test('a política de rede continua valendo: câmera comum com destino proibido é recusada', async () => {
  const svc = servicoComStubs();
  // MESMA câmera, sem o modo push: agora o destino é discado de verdade e
  // 0.0.0.0 tem de ser recusado. Se este teste passar a falhar, a correção
  // de ordem virou buraco de segurança.
  await assert.rejects(
    () => svc.buildAiSource({ ...CAMERA_RTMP, sourceMode: 'rtsp_pull' }),
    /política de rede|IP literal/i,
  );
});
