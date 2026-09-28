import { BadRequestException, Body, Controller, Get, Optional, Param, Post, Query, Req, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { RtmpDiscoveryService } from '../cameras/rtmp-discovery.service';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { type Request, type Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AccessControlService } from '../access-control/access-control.service';
import { AuthService } from '../auth/auth.service';
import { CommercialPolicyService } from '../commercial-policy/commercial-policy.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { timingSafeTextEquals } from '../common/security/timing-safe.helper';
import { Roles } from '../auth/decorators/roles.decorator';
import { type AuthUser } from '../common/types/auth-user.type';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { createReadStream, statSync } from 'node:fs';
import { ClipCaptureService } from './clip-capture.service';
import { FfmpegMjpegService } from './ffmpeg-mjpeg.service';
import { MediamtxProxyService } from './mediamtx-proxy.service';
import { StreamResourceAdvisorService } from './stream-resource-advisor.service';
import { assessLiveReadiness } from './helpers/live-readiness.helper';
import { CamerasService } from '../cameras/cameras.service';
import { ingestKeyFromPathName } from '../cameras/helpers/rtmp-ingest.helper';
import { PendingIngestRegistry } from '../cameras/pending-ingest.registry';
import {
  GRID_LIVE_MAX_HEIGHT,
  GRID_LIVE_MAX_WIDTH,
  GRID_LIVE_TARGET_FPS,
  normalizeLiveViewMode,
} from './helpers/live-delivery-profile.helper';
import {
  isHevcCodec,
  resolveDeliveryRtspProfile,
  resolveDeliveryVideoCodec,
  resolveLiveRtspProfile,
  resolveOriginalRtspProfile,
  resolveOriginalVideoCodec,
} from '../cameras/helpers/rtsp-url.helper';

type LiveProtocol = 'auto' | 'flv' | 'hls' | 'llhls' | 'webrtc' | 'mjpeg';
type MediaMtxAuthRequest = {
  user?: string;
  password?: string;
  token?: string;
  action?: string;
  path?: string;
  protocol?: string;
  ip?: string;
};

type SrsPublishHookRequest = {
  action?: string;
  ip?: string;
  app?: string;
  stream?: string;
};

export function isLoopbackMediaWorkerAuthorized(body: MediaMtxAuthRequest) {
  const action = String(body?.action ?? '');
  const path = String(body?.path ?? '');
  const sourcePath = /^cam_[0-9a-f]{32}(?:_grid|_grid_audio|_grid_hevc|_orig|_orig_audio)?_source$/i.test(path);
  const outputPath = /^cam_[0-9a-f]{32}(?:_grid|_grid_audio|_grid_hevc|_orig|_orig_audio)?$/i.test(path);
  // MediaMTX 1.15 pode enviar somente o IP ou IP:porta no callback HTTP,
  // dependendo do transporte RTSP. O publisher `runOnDemand` disca para o
  // próprio 127.0.0.1; rejeitar a variação com porta fazia o FFmpeg receber
  // 401 no ANNOUNCE e toda câmera HEVC ficava eternamente em "Conectando".
  // Não aceitamos rede Docker aqui: continua sendo estritamente loopback.
  const rawIp = String(body?.ip ?? '').trim().toLowerCase();
  const loopback =
    rawIp === '127.0.0.1'
    || rawIp === '::1'
    || rawIp === '::ffff:127.0.0.1'
    || /^127\.0\.0\.1:\d+$/.test(rawIp)
    || /^\[::1\]:\d+$/.test(rawIp)
    || /^\[::ffff:127\.0\.0\.1\]:\d+$/.test(rawIp);
  return (
    loopback
    && (
      (sourcePath && (action === 'read' || action === 'playback'))
      || (outputPath && action === 'publish')
    )
  );
}

@Controller('camera-stream')
export class CameraStreamController {
  // Câmeras não vinculadas costumam reconectar em poucos segundos. Negativas
  // são cacheadas por um intervalo curto para que uma única câmera errada não
  // transforme o banco em rate limiter; vínculo recém-criado passa em até 15 s.
  private readonly rejectedSrsPaths = new Map<string, number>();

  constructor(
    private readonly ffmpegMjpegService: FfmpegMjpegService,
    private readonly clipCaptureService: ClipCaptureService,
    private readonly mediamtxProxyService: MediamtxProxyService,
    private readonly camerasService: CamerasService,
    private readonly authService: AuthService,
    private readonly accessControlService: AccessControlService,
    private readonly auditService: AuditService,
    private readonly commercialPolicy: CommercialPolicyService,
    private readonly streamResourceAdvisor: StreamResourceAdvisorService,
    private readonly configService: ConfigService,
    private readonly pendingIngest: PendingIngestRegistry,
    @Optional() private readonly discovery?: RtmpDiscoveryService,
  ) {}

  private extractBearerToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string') return null;
    if (!authHeader.toLowerCase().startsWith('bearer ')) return null;
    const token = authHeader.slice(7).trim();
    return token || null;
  }

  private supportsHevcWebPlayback(req: Request) {
    // O aplicativo nativo faz a tentativa de H.265 por WebRTC e possui fallback
    // HLS local. O opt-in evita oferecer HEVC/WHEP a navegadores que certamente
    // não o negociam, preservando o comportamento seguro da web.
    if (String(req.headers['x-s2cam-native-webrtc'] ?? '').toLowerCase() === 'hevc') return true;
    const ua = String(req.headers['user-agent'] ?? '').toLowerCase();
    const isAppleDevice = /iphone|ipad|ipod|macintosh|mac os x/.test(ua);
    const isSafariFamily =
      ua.includes('safari') &&
      !ua.includes('chrome') &&
      !ua.includes('chromium') &&
      !ua.includes('crios') &&
      !ua.includes('fxios') &&
      !ua.includes('edgios') &&
      !ua.includes('opr') &&
      !ua.includes('opera');
    return isAppleDevice && isSafariFamily;
  }

  private resolveApiPublicBase(req: Request) {
    const configured = String(
      this.configService.get<string>('apiPublicUrl') ?? process.env.API_PUBLIC_URL ?? '',
    ).trim().replace(/\/+$/, '');
    if (configured) return configured;

    const hostHeader = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost:3000';
    const apiHost = hostHeader.split(',')[0].trim();
    const reqProto = ((req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http')
      .split(',')[0]
      .trim();
    return `${reqProto}://${apiHost}`;
  }

  /**
   * O SRS recebe `publish` antes de o primeiro pacote de mídia existir. É o
   * único ponto confiável para aprender câmeras FMLE que recebem o aceite e
   * desligam sem mandar um quadro — nesse caso o callback do MediaMTX nunca é
   * alcançado e a antiga lista de pendentes ficava vazia para sempre.
   *
   * Este também é o primeiro portão de autorização. Recusar aqui impede o SRS
   * de manter/encaminhar centenas de sessões que o MediaMTX recusaria depois.
   */
  @Public()
  @SkipThrottle()
  @Post('srs-publish')
  async recordSrsPublishAttempt(
    @Body() body: SrsPublishHookRequest,
    @Query('internalToken') internalToken: string | undefined,
    @Res() res: Response,
  ) {
    const expectedCallbackToken = (
      this.configService.get<string>('mediaMtxAuthCallbackToken') ?? ''
    ).trim();
    if (
      expectedCallbackToken.length < 32
      || !internalToken
      || !timingSafeTextEquals(internalToken, expectedCallbackToken)
    ) {
      return res.status(401).json({ code: 1, message: 'Callback de mídia não autenticado.' });
    }

    // Hook diferente de on_publish não deve virar dado operacional.
    if (String(body?.action ?? '') !== 'on_publish') {
      return res.status(400).json({ code: 1, message: 'Ação de callback inválida.' });
    }

    const app = String(body?.app ?? '').trim().replace(/^\/+|\/+$/g, '');
    const stream = String(body?.stream ?? '').trim().replace(/^\/+|\/+$/g, '');
    const path = `${app}/${stream}`;

    if (!app || !stream) {
      return res.status(200).json({ code: 1, message: 'Caminho de publicação inválido.' });
    }

    if (this.discovery?.allows(path, body?.ip)) return res.status(200).json({ code: 0 });
    const cachedUntil = this.rejectedSrsPaths.get(path) ?? 0;
    if (cachedUntil > Date.now()) {
      this.pendingIngest.record(path, body?.ip ?? null);
      return res.status(200).json({ code: 1, message: 'Equipamento ainda não vinculado.' });
    }
    this.rejectedSrsPaths.delete(path);

    const ingestKey = ingestKeyFromPathName(path);
    let camera: any;
    try {
      camera = ingestKey
        ? (await this.camerasService.findCameraByIngestKey(ingestKey) || await this.camerasService.findCameraByIngestPath(path))
        : await this.camerasService.findCameraByIngestPath(path);
    } catch {
      // Autorização fail-closed: banco indisponível nunca abre uma publicação.
      return res.status(200).json({ code: 1, message: 'Autorização temporariamente indisponível.' });
    }
    if (!camera) {
      this.pendingIngest.record(path, body?.ip ?? null);
      this.rejectedSrsPaths.set(path, Date.now() + 15_000);
      if (this.rejectedSrsPaths.size > 2048) {
        const oldest = this.rejectedSrsPaths.keys().next().value;
        if (oldest) this.rejectedSrsPaths.delete(oldest);
      }
      return res.status(200).json({ code: 1, message: 'Equipamento ainda não vinculado.' });
    }

    return res.status(200).json({ code: 0 });
  }

  @Public()
  @SkipThrottle()
  @Post('mediamtx-auth')
  async authorizeMediaMtx(
    @Body() body: MediaMtxAuthRequest,
    @Query('internalToken') internalToken: string | undefined,
    @Res() res: Response,
  ) {
    const deny = (message: string) => res.status(401).json({ message });
    const expectedCallbackToken = (
      this.configService.get<string>('mediaMtxAuthCallbackToken') ?? ''
    ).trim();
    if (
      expectedCallbackToken.length < 32
      || !internalToken
      || !timingSafeTextEquals(internalToken, expectedCallbackToken)
    ) {
      return deny('Callback de mídia não autenticado.');
    }

    const expectedUser = (this.configService.get<string>('mediaMtxApiUser') ?? '').trim();
    const expectedPass = (this.configService.get<string>('mediaMtxApiPass') ?? '').trim();
    const suppliedUser = String(body?.user ?? '');
    const suppliedPass = String(body?.password ?? '');
    const action = String(body?.action ?? '');

    // O runOnDemand nasce dentro do próprio container MediaMTX. Ele lê apenas o
    // path oculto `_source` e publica apenas no path público correspondente.
    // Assim os URLs usados no argv não carregam nem a senha da câmera nem a
    // credencial administrativa do MediaMTX.
    if (isLoopbackMediaWorkerAuthorized(body)) {
      return res.status(200).json({ authorized: true });
    }

    // Processos internos (API, métricas e publishers FFmpeg) continuam usando a
    // credencial administrativa já existente. O endpoint só é chamado pela rede
    // interna do Compose (o nginx o bloqueia com 404 na borda), mas a credencial
    // ainda é obrigatória — e a comparação é em tempo constante: acertá-la libera
    // read E publish em QUALQUER path, ignorando streamToken e ACL.
    if (
      expectedUser &&
      expectedPass &&
      timingSafeTextEquals(suppliedUser, expectedUser) &&
      timingSafeTextEquals(suppliedPass, expectedPass)
    ) {
      return res.status(200).json({ authorized: true });
    }

    // ── PUBLICAÇÃO POR RTMP: a câmera é que disca ───────────────────────────
    //
    // Único caminho em que publicar é permitido sem a credencial administrativa,
    // e ele é estreito de propósito:
    //  · só a ação 'publish', só nos protocolos rtmp/rtmps;
    //  · só em `drac/<32 hex>`, `d2/<22 base62>` ou no alias histórico
    //    `d/<22 base64url>` —
    //    nenhum nome de path de câmera casa com esses padrões;
    //  · a chave autentica por hash, em tempo constante, e some se a câmera for
    //    desabilitada ou tirada do modo push.
    //
    // Publicar NÃO concede leitura: assistir continua exigindo streamToken, como
    // antes desta funcionalidade existir.
    if (action === 'publish') {
      const protocolo = String(body?.protocol ?? '').toLowerCase();
      if (protocolo !== 'rtmp' && protocolo !== 'rtmps') {
        return deny('Publicação permitida apenas por RTMP.');
      }
      const caminho = String(body?.path ?? '');
      if (this.discovery?.allows(caminho)) return res.status(200).json({ authorized: true });

      // 1ª via: a chave que NÓS geramos, no formato histórico hexadecimal ou
      // no alias Base62 atual ou Base64URL histórico, ambos com 128 bits.
      const chave = ingestKeyFromPathName(caminho);
      if (chave) {
        const camera = await this.camerasService.findCameraByIngestKey(chave).catch(() => null);
        if (camera || await this.camerasService.findCameraByIngestPath(caminho).catch(() => null)) return res.status(200).json({ authorized: true });
        this.pendingIngest.record(caminho, body?.ip ?? null);
        return deny('Chave de publicação inválida.');
      }

      // 2ª via: o caminho PRÓPRIO do equipamento, já confirmado por um
      // administrador. Existe porque muita câmera não deixa escolher para onde
      // publicar — ela monta o caminho do número de série e ignora o resto.
      const porCaminho = await this.camerasService.findCameraByIngestPath(caminho).catch(() => null);
      if (porCaminho) return res.status(200).json({ authorized: true });

      // Desconhecido: recusa, mas NÃO em silêncio. A tentativa vira uma linha na
      // tela para o administrador dizer de qual câmera é. Recusar calado foi o
      // que transformou a primeira tentativa de campo num mistério que só se
      // resolveu capturando pacote.
      this.pendingIngest.record(caminho, body?.ip ?? null);
      return deny('Equipamento ainda não vinculado a uma câmera.');
    }

    if (action !== 'read' && action !== 'playback') {
      return deny('Ação de mídia não autorizada.');
    }

    const match = /^cam_([0-9a-f]{32})(?:_grid|_grid_audio|_grid_hevc|_orig|_orig_audio)?$/i.exec(String(body?.path ?? ''));
    if (!match) return deny('Caminho de mídia inválido.');

    const token = String(body?.token ?? '').trim();
    if (!token) return deny('Token de mídia ausente.');

    try {
      const payload = await this.authService.verifyStreamToken(token);
      const tokenCameraId = payload.cameraId.replace(/-/g, '').toLowerCase();
      if (tokenCameraId !== match[1].toLowerCase()) {
        return deny('Token não corresponde à câmera.');
      }
      return res.status(200).json({ authorized: true });
    } catch {
      return deny('Token de mídia inválido ou expirado.');
    }
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Post(':cameraId/token')
  async createStreamToken(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Req() req: Request,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('localLive', user);
    if (((await this.camerasService.getCameraOrThrow(cameraId)) as { enabled?: boolean }).enabled === false) {
      throw new BadRequestException('Câmera desativada.');
    }
    const token = await this.authService.createStreamToken(user.id, cameraId);
    await this.auditService.log(user.id, 'stream.token.create', 'Camera', cameraId, null, req);
    return token;
  }

  /**
   * Quais câmeras têm fonte leve para o mosaico, e quais não têm.
   *
   * Rota ESTÁTICA antes das que usam `:cameraId` — depois delas, "fontes-do-
   * mosaico" seria lido como um id de câmera.
   */
  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Get('fontes-do-mosaico')
  async fontesDoMosaico() {
    return { items: await this.mediamtxProxyService.relatorioDeFontesDoMosaico() };
  }

  /** Manda esquecer o que sabemos e procurar de novo nesta câmera. */
  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Post(':cameraId/reaprender-fonte')
  async reaprenderFonte(@Param('cameraId') cameraId: string) {
    await this.mediamtxProxyService.reaprenderFonteDoMosaico(cameraId);
    return { ok: true };
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Get('stats')
  async getGlobalStats() {
    return this.ffmpegMjpegService.getStreamStats();
  }

  // Vazão ao vivo da instalação: banda ENTRANDO (câmeras→servidor) e SAINDO
  // (servidor→espectadores), em Mbps, + nº de espectadores. Lida do MediaMTX.
  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Get('throughput')
  async getThroughput() {
    return this.mediamtxProxyService.getLiveThroughput();
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Get(':cameraId/stats')
  async getCameraStats(@Param('cameraId') cameraId: string) {
    return this.ffmpegMjpegService.getStreamStats(cameraId);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Get('resource-diagnostics')
  async getResourceDiagnostics(@CurrentUser() user: AuthUser) {
    const accessibleCameraIds = await this.accessControlService.getAccessibleCameraIds(user);
    return this.streamResourceAdvisor.getFleetReport(accessibleCameraIds);
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Get('optimization-plan')
  async getOptimizationPlan(@CurrentUser() user: AuthUser) {
    const accessibleCameraIds = await this.accessControlService.getAccessibleCameraIds(user);
    return this.streamResourceAdvisor.getOptimizationPlan(accessibleCameraIds);
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Post('optimization/apply-safe')
  async applySafeOptimization(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const accessibleCameraIds = await this.accessControlService.getAccessibleCameraIds(user);
    const result = await this.streamResourceAdvisor.applySafeOptimizations(accessibleCameraIds);
    await this.auditService.log(user.id, 'stream.optimization.apply_safe', 'Camera', null, result as any, req);
    return result;
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Get(':cameraId/resource-diagnostics')
  async getCameraResourceDiagnostics(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    return this.streamResourceAdvisor.getCameraReport(cameraId);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Post(':cameraId/live-failure')
  async recordLiveFailure(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Body() body: { protocol?: string; reason?: string; stage?: string; state?: string },
    @Req() req: Request,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    const protocol = String(body?.protocol || 'unknown').slice(0, 32);
    const stage = String(body?.stage || 'startup').slice(0, 64);
    const reason = String(body?.reason || 'Falha de live sem detalhe informado.').slice(0, 500);
    const state = String(body?.state || '').slice(0, 64) || null;
    await this.auditService.log(user.id, 'stream.live.failure', 'Camera', cameraId, {
      protocol,
      stage,
      reason,
      state,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 240),
    }, req);
    return { accepted: true, cameraId, protocol, stage };
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Get(':cameraId/urls')
  async getDeliveryUrls(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Query('viewMode') rawViewMode: string | undefined,
    @Req() req: Request,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('localLive', user);
    const camera = await this.camerasService.getCameraOrThrow(cameraId);
    if ((camera as { enabled?: boolean }).enabled === false) {
      throw new BadRequestException('Câmera desativada. Reative-a nas configurações para ver ao vivo.');
    }
    const token = await this.authService.createStreamToken(user.id, cameraId);
    const viewMode = normalizeLiveViewMode(rawViewMode);

    // Atualiza metadados em segundo plano. Abrir uma live nunca deve esperar
    // uma sonda RTSP/ffprobe, que pode levar vários segundos em câmera instável.
    if (!camera.detectedVideoCodec || !camera.detectedWidth || !camera.detectedHeight) {
      void this.camerasService.getStatus(cameraId).catch(() => undefined);
    }

    let mediaBridge = this.mediamtxProxyService.buildPublicUrls(req, null, null);
    let measuredLiveCodec: string | null = null;
    let liveTranscodedForBrowser = false;
    let gridSourceIsOriginal = false;
    let effectiveDeliveryProfile = resolveDeliveryRtspProfile(camera);
    if (this.mediamtxProxyService.isEnabled()) {
      try {
        // Sinal de RELEVÂNCIA para o conjunto quente da grade: só a demanda de
        // ESPECTADOR marca (este endpoint). Warm-up e watchdog chamam o ensure
        // por dentro do serviço e não marcam — senão o boot "veria" a frota
        // inteira e a política viraria "quente para sempre" de novo.
        if (viewMode === 'grid' || viewMode === 'grid-hevc') {
          this.mediamtxProxyService.markGridViewed(cameraId);
        }
        const ensured = await this.mediamtxProxyService.ensurePathForCamera(cameraId, viewMode);
        mediaBridge = this.mediamtxProxyService.buildPublicUrls(req, ensured.pathName, ensured.sourceUrl);
        measuredLiveCodec = ensured.sourceVideoCodec;
        gridSourceIsOriginal = ensured.sourceIsOriginal === true;
        // `transcodedForLive` também cobre AAC→Opus: há um publisher, mas o
        // vídeo H.264 continua em cópia. O selo do painel é exclusivamente
        // sobre H.265→H.264 (o custo de vídeo que chega a ~5×), portanto não
        // pode usar esse booleano amplo e assustar o operador sem motivo.
        liveTranscodedForBrowser = ensured.transcodedForLive
          && isHevcCodec(ensured.sourceVideoCodec);
        effectiveDeliveryProfile = ensured.liveProfile ?? effectiveDeliveryProfile;
      } catch (error) {
        // Uma câmera RTMP só existe enquanto o equipamento/app está publicando.
        // Não devolvemos URLs vazias como se a live estivesse iniciando: o
        // player precisa encerrar a espera e informar o operador sem expor
        // detalhes internos de MediaMTX/SRS.
        if ((camera as { sourceMode?: string | null }).sourceMode === 'rtmp_push') {
          const detail = error instanceof Error ? error.message : 'publicação RTMP indisponível';
          throw new ServiceUnavailableException({
            error: 'rtmp_source_unavailable',
            userMessage: 'Aguardando transmissão RTMP da câmera. Verifique se o equipamento ou aplicativo continua enviando vídeo.',
            adminMessage: detail,
          });
        }
        mediaBridge = this.mediamtxProxyService.buildPublicUrls(req, null, null);
      }
    }

    const hostHeader = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost:3000';
    const apiHost = hostHeader.split(',')[0].trim();
    const reqProto = ((req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http')
      .split(',')[0]
      .trim();
    const apiPublicBase = this.resolveApiPublicBase(req);
    const flvUrl = `${apiPublicBase}/camera-stream/${cameraId}/flv`;
    const posterUrl = `${apiPublicBase}/camera-stream/${cameraId}/poster`;

    const configuredPreferred = (camera.preferredLiveProtocol ?? 'webrtc').toLowerCase();
    const configuredCodec = camera.streamVideoCodec ?? null;
    const originalCodec = resolveOriginalVideoCodec(camera);
    const sourceCodec = measuredLiveCodec ?? resolveDeliveryVideoCodec(camera);
    const liveProfile = resolveLiveRtspProfile(camera);
    const originalProfile = resolveOriginalRtspProfile(camera);
    const deliveryProfile = effectiveDeliveryProfile;
    const smartOriginalEnabled = liveTranscodedForBrowser || isHevcCodec(sourceCodec);
    const supportsOriginalOnClient = this.supportsHevcWebPlayback(req);

    const { sourceUrl: _sourceUrl, ...safeMediaBridge } = mediaBridge;
    // HEVC/WHEP só é oferecido a clientes que declaram suporte. Navegadores sem
    // suporte continuam exclusivamente no HLS; o app nativo tenta WebRTC e tem
    // o próprio fallback para HLS, sem conversão do vídeo original.
    const originalHlsOnly = (viewMode === 'original' || viewMode === 'original-audio')
      && isHevcCodec(sourceCodec ?? originalCodec)
      && !supportsOriginalOnClient;
    const clientMediaBridge = originalHlsOnly
      ? { ...safeMediaBridge, whepUrl: null, webrtcUrl: null }
      : safeMediaBridge;
    const effectivePreferred = originalHlsOnly ? 'hls' : configuredPreferred;
    const requestOrigin = `${reqProto}://${apiHost}`;
    const liveReadiness = assessLiveReadiness({
      requestOrigin,
      publicAppUrl: process.env.PUBLIC_APP_URL || null,
      mediamtxEnabled: this.mediamtxProxyService.isEnabled(),
      pathReady: Boolean(clientMediaBridge.enabled && clientMediaBridge.pathName),
      whepUrl: clientMediaBridge.whepUrl,
      hlsUrl: clientMediaBridge.hlsUrl,
      webrtcAllowOrigin: process.env.MEDIAMTX_WEBRTC_ALLOW_ORIGIN || null,
    });
    const fallbackManualOrder: LiveProtocol[] = (() => {
      switch (configuredPreferred as LiveProtocol) {
        case 'webrtc':
          return ['webrtc', 'llhls', 'hls'];
        case 'llhls':
          return ['llhls', 'hls', 'webrtc'];
        case 'hls':
          return ['hls', 'llhls', 'webrtc'];
        case 'flv':
          // FLV legado: mantém compatibilidade de leitura, mas força rota HTTP estável.
          return ['llhls', 'hls', 'webrtc'];
        case 'auto':
          return ['webrtc', 'llhls', 'hls'];
        default:
          return ['webrtc', 'llhls', 'hls'];
      }
    })();

    const protocolOrder: LiveProtocol[] = originalHlsOnly
      ? ['llhls', 'hls']
      : smartOriginalEnabled
      ? ['webrtc', 'llhls', 'hls']
      : fallbackManualOrder;

    return {
      cameraId,
      streamToken: token.streamToken,
      streamTokenExpiresAt: token.expiresAt,
      preferredLiveProtocol: effectivePreferred,
      preferredRtspTransport: camera.preferredRtspTransport ?? 'tcp',
      configuredVideoCodec: configuredCodec,
      sourceVideoCodec: sourceCodec,
      detectedVideoCodec: sourceCodec, // retrocompatibilidade no frontend
      originalVideoCodec: originalCodec,
      liveProfile,
      originalProfile,
      deliveryProfile,
      deliveryMode: viewMode,
      deliveryTarget: viewMode === 'grid' || viewMode === 'grid-audio' || viewMode === 'grid-hevc'
        ? {
            maxWidth: GRID_LIVE_MAX_WIDTH,
            maxHeight: GRID_LIVE_MAX_HEIGHT,
            targetFps: GRID_LIVE_TARGET_FPS,
            browserCodec: viewMode === 'grid-hevc' ? sourceCodec : 'h264',
            sourceIsOriginal: gridSourceIsOriginal,
          }
        : {
            originalResolution: true,
            originalFps: true,
            browserCodec: sourceCodec ?? originalCodec ?? configuredCodec,
          },
      smartLive: {
        enabled: smartOriginalEnabled,
        supportsOriginalOnClient,
        recommendedProtocol: protocolOrder[0],
        protocolOrder,
        reason: originalHlsOnly
          ? 'Máxima resolução preserva o H.265 original e usa HLS diretamente, sem conversão nem tentativa WebRTC incompatível.'
          : viewMode === 'grid-hevc'
          ? 'A grade recebe o substream no codec original e prioriza WebRTC; H.264 é apenas contingência do cliente.'
          : viewMode === 'grid-audio'
          ? 'Áudio foi solicitado para este tile; somente esta câmera normaliza AAC em Opus.'
          : smartOriginalEnabled
          ? 'Perfil Live recebido em HEVC; navegador recebe H.264, enquanto gravação permanece no perfil H.265 dedicado.'
          : configuredPreferred === 'webrtc'
            ? 'WebRTC configurado como protocolo principal; LL-HLS/HLS ficam apenas como contingência técnica.'
            : 'Ordem de fallback baseada no protocolo configurado.',
      },
      liveDiagnostics: {
        generatedAt: new Date().toISOString(),
        publicAppUrl: process.env.PUBLIC_APP_URL || null,
        apiPublicUrl: process.env.API_PUBLIC_URL || null,
        mediaMtxPublicHost: process.env.MEDIAMTX_PUBLIC_HOST || null,
        mediaMtxPublicScheme: process.env.MEDIAMTX_PUBLIC_SCHEME || null,
        mediaMtxPublicWebrtcUrl: process.env.MEDIAMTX_PUBLIC_WEBRTC_URL || null,
        mediaMtxPublicHlsUrl: process.env.MEDIAMTX_PUBLIC_HLS_URL || null,
        mediaMtxWebrtcAllowOrigin: process.env.MEDIAMTX_WEBRTC_ALLOW_ORIGIN || null,
        mediaMtxHlsAllowOrigin: process.env.MEDIAMTX_HLS_ALLOW_ORIGIN || null,
        mediamtxEnabled: this.mediamtxProxyService.isEnabled(),
        pathReady: Boolean(clientMediaBridge.enabled && clientMediaBridge.pathName),
        pathName: clientMediaBridge.pathName ?? null,
        sourceVideoCodec: sourceCodec,
        originalVideoCodec: originalCodec,
        liveTranscodedForBrowser,
        // ── CUSTO DA CONVERSÃO, EXPLÍCITO ───────────────────────────────────
        //
        // Medido na simulação de capacidade (2026-08-03): entregar H.265
        // convertendo para H.264 custa 6,6% de CPU por câmera, contra 1,3% em
        // passthrough — CINCO VEZES mais. Numa frota H.265 isso divide a
        // capacidade do servidor por cinco, e hoje acontece em silêncio.
        //
        // O operador não tem como saber que o navegador dele é a causa. Com este
        // campo a interface pode dizer, e a escolha passa a ser informada:
        // trocar de navegador sai de graça e devolve 5× de capacidade.
        transcodeCost: liveTranscodedForBrowser
          ? {
            cpuMultiplier: 5,
            reason: supportsOriginalOnClient
              ? 'A fonte é H.265 e este modo de entrega exige conversão.'
              : 'Este navegador não decodifica H.265, então o servidor converte para H.264.',
            hint: supportsOriginalOnClient
              ? 'O modo "Máxima qualidade" entrega H.265 sem conversão.'
              : 'Um cliente com H.265/WebRTC reproduz o codec direto, sem custo de conversão.',
          }
          : null,
        liveProfile,
        deliveryProfile,
        deliveryMode: viewMode,
        preferredProtocol: effectivePreferred,
        protocolOrder,
        readiness: liveReadiness,
      },
      protocols: {
        flvUrl,
        posterUrl,
        ...clientMediaBridge,
      },
    };
  }

  // Emite tokens de poster em LOTE, SEM iniciar path MediaMTX (diferente de
  // /urls, que chama ensurePathForCamera e sobe um restream por câmera). Serve
  // p/ os tiles da grade mostrarem um snapshot de TODAS as câmeras sem custo de
  // stream: o /poster gera 1 frame (cache 15s) puxando direto do RTSP quando
  // não há path live. Câmeras sem acesso são apenas omitidas do resultado.
  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Post('poster-tokens')
  async getPosterTokens(
    @CurrentUser() user: AuthUser,
    @Body() body: { cameraIds?: unknown },
    @Req() req: Request,
  ) {
    await this.commercialPolicy.assertFeature('localLive', user);
    const ids = Array.isArray(body?.cameraIds)
      ? (body.cameraIds.filter((v) => typeof v === 'string' && v.length > 0) as string[]).slice(0, 200)
      : [];
    const apiPublicBase = this.resolveApiPublicBase(req);
    const items: { cameraId: string; streamToken: string; posterUrl: string }[] = [];
    for (const cameraId of ids) {
      try {
        await this.accessControlService.assertCanViewCamera(user, cameraId);
        const token = await this.authService.createStreamToken(user.id, cameraId);
        items.push({
          cameraId,
          streamToken: token.streamToken,
          posterUrl: `${apiPublicBase}/camera-stream/${cameraId}/poster`,
        });
      } catch {
        // Sem acesso / câmera inexistente: omite do lote, não derruba o resto.
      }
    }
    return { items };
  }

  // ── Gravação de CLIPE sob demanda (exato start→stop) para "salvar no celular"
  // O app inicia, o servidor grava com `-c copy`, o app para e baixa o arquivo.
  // Permissão: VER a câmera basta (é o "salvar o que já estou vendo", como a
  // Foto) — NÃO exige permissão de gravação do NVR, senão usuários VIEWER dos
  // clientes ficam com o botão morto.
  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Post(':cameraId/clip/start')
  async startClip(@CurrentUser() user: AuthUser, @Param('cameraId') cameraId: string) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('localLive', user);
    return this.clipCaptureService.start(cameraId, user.id);
  }

  @Roles(UserRole.VIEWER)
  @Post('clip/:clipId/stop')
  async stopClip(@CurrentUser() user: AuthUser, @Param('clipId') clipId: string) {
    return this.clipCaptureService.stop(clipId, user.id);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Get('clip/:clipId/download')
  async downloadClip(
    @CurrentUser() user: AuthUser,
    @Param('clipId') clipId: string,
    @Res() res: Response,
  ) {
    const cameraId = this.clipCaptureService.getCameraId(clipId, user.id);
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('localLive', user);
    const filePath = this.clipCaptureService.getClipFile(clipId, user.id);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="clip-${clipId}.mp4"`);
    res.setHeader('Content-Length', String(statSync(filePath).size));
    res.setHeader('Cache-Control', 'private, no-store');
    const stream = createReadStream(filePath);
    stream.pipe(res);
    // Download é repetível: fechar a conexão não comprova persistência no app.
    res.on('close', () => stream.destroy());
    stream.on('error', () => { try { res.end(); } catch { /* */ } });
  }

  @Public()
  @Get(':cameraId/poster')
  async getPoster(
    @Param('cameraId') cameraId: string,
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
    @Query('fresh') fresh?: string,
    @Query('capture') capture?: string,
  ) {
    const bearerToken = this.extractBearerToken(req);
    const tokenValue = token?.trim() || bearerToken;
    if (!tokenValue) {
      throw new UnauthorizedException('Token de stream ausente.');
    }

    const payload = await this.authService.verifyStreamToken(tokenValue);
    if (payload.cameraId !== cameraId) {
      throw new UnauthorizedException('Token inválido para esta câmera.');
    }
    const tokenUser = await this.authService.me(payload.sub);
    await this.accessControlService.assertCanViewCamera(tokenUser, cameraId);

    // A primeira chamada pode responder instantaneamente com a última gravação.
    // `fresh=1` aguarda a captura live já iniciada por ela, sem duplicar FFmpeg.
    const poster = await this.ffmpegMjpegService.getLivePosterFrame(cameraId, fresh === '1', capture === '1');
    res.status(200);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', String(poster.buffer.length));
    res.setHeader('Cache-Control', capture === '1' ? 'private, no-store' : 'private, max-age=10, stale-while-revalidate=20');
    res.setHeader('X-Poster-Generated-At', new Date(poster.generatedAt).toISOString());
    res.setHeader('X-Poster-Source', poster.source);
    res.end(poster.buffer);
  }

  @Public()
  @Get(':cameraId/flv')
  async getFlv(
    @Param('cameraId') cameraId: string,
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const bearerToken = this.extractBearerToken(req);
    const tokenValue = token?.trim() || bearerToken;
    if (!tokenValue) {
      throw new UnauthorizedException('Token de stream ausente.');
    }

    const payload = await this.authService.verifyStreamToken(tokenValue);
    if (payload.cameraId !== cameraId) {
      throw new UnauthorizedException('Token inválido para esta câmera.');
    }
    const tokenUser = await this.authService.me(payload.sub);
    await this.accessControlService.assertCanViewCamera(tokenUser, cameraId);

    await this.ffmpegMjpegService.startFlvStream(cameraId, req, res);
  }
}
