import { BadRequestException, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Request } from 'express';
import { CamerasService } from '../cameras/cameras.service';
import { SharedRtspSourceService } from '../cameras/shared-rtsp-source.service';
import {
  buildRtspUrl,
  isHevcCodec,
  resolveGridRtspProfile,
  resolveLiveRtspProfile,
  resolveOriginalRtspProfile,
} from '../cameras/helpers/rtsp-url.helper';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { isManagedLivePublisher, withTranscodeAdmission, withWeightedTranscodeAdmission, liveConversionCost } from './helpers/transcode-admission.helper';
import { audioCodecFromTracks } from './helpers/live-audio.helper';
import { trackPacketHealth, type TrackPacketHealth } from './helpers/track-packet-health.helper';
import { envNumber } from '../common/config/env-number.helper';
import {
  ingestPathNames,
  isAcceptableIngestPath,
  isPushSourced,
  isValidIngestKey,
  normalizeIngestPath,
} from '../cameras/helpers/rtmp-ingest.helper';
import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  computeHotGridSet,
  pruneHistory,
  seedEmptyHistory,
  DEFAULT_HOT_GRID_BUDGET,
  DEFAULT_HOT_GRID_WINDOW_HOURS,
  type GridViewEntry,
} from './helpers/hot-grid-sources.helper';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { spawnWithSecretUrl } from '../common/process/secret-url-process.helper';
// Métricas por câmera: singleton de módulo (sem DI, para não mexer no construtor
// deste serviço) e sempre em try/catch — observabilidade não derruba stream.
import { cameraMetrics } from '../observability/camera-metrics.service';
import {
  GRID_LIVE_BITRATE_KBPS,
  GRID_LIVE_MAX_HEIGHT,
  GRID_LIVE_MAX_WIDTH,
  GRID_LIVE_TARGET_FPS,
  INSTANT_LIVE_MAX_BITRATE_KBPS,
  resolveInstantBitrateKbps,
  type LiveViewMode,
  gridFollowsCameraProfile,
  parseGridSourcePolicy,
  streamDiffersInAspect,
  gradeDeveUsarPrincipalPorFormato,
} from './helpers/live-delivery-profile.helper';
import { liveViewModeToSourceProfile } from './helpers/source-profile.helper';
import { decidirCopiaDeVideo } from './helpers/copia-em-vez-de-reencode.helper';
import { SourceGatewayService } from './source-gateway.service';
import { RtmpIngestSourceService } from '../cameras/rtmp-ingest-source.service';
import { conferirPadrao, resumirFrota } from './helpers/padrao-de-stream.helper';
import {
  comSegredo,
  impressaoDoCadastro,
  lerAnotacao,
  semSegredo,
} from './helpers/memoria-do-mosaico.helper';

/** O padrão de instalação, em uma frase, para a tela repetir. */
const PADRAO_EM_PALAVRAS = 'Principal 1080p em H.265; stream 2 em 480p H.264.';

type StreamMetadata = {
  codec: string | null;
  width: number | null;
  height: number | null;
  hasDataTrack: boolean;
  audioCodec?: string | null;
};

type DeliveryUrls = {
  enabled: boolean;
  pathName: string | null;
  sourceUrl: string | null;
  webrtcUrl: string | null;
  whepUrl: string | null;
  hlsUrl: string | null;
  rtspProxyUrl: string | null;
};

type EnsuredCameraPath = {
  pathName: string | null;
  sourceUrl: string | null;
  sourceVideoCodec: string | null;
  transcodedForLive: boolean;
  videoEncoded?: boolean;
  audioEncoded?: boolean;
  audioAvailable?: boolean | null;
  liveProfile: { channel: number; subtype: number } | null;
  deliveryMode: LiveViewMode;
  /** A fonte efetiva da grade já é o mesmo perfil físico da máxima resolução. */
  sourceIsOriginal?: boolean;
};

@Injectable()
export class MediamtxProxyService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MediamtxProxyService.name);
  private readonly liveCodecCache = new Map<string, { isHevc: boolean; at: number }>();
  private readonly liveSourceCache = new Map<string, { url: string; codec: string | null; width: number | null; height: number | null; at: number }>();
  // Cache da decisão da fonte da GRADE por câmera: URL escolhida + codec do sub
  // (url null = sem sub, usa o main). Evita ffprobe a cada (re)configuração.
  private readonly gridSourceCache = new Map<string, {
    url: string | null;
    codec: string | null;
    width: number | null;
    height: number | null;
    requiresSanitization: boolean;
    at: number;
  }>();
  private readonly pathEnsureInFlight = new Map<string, Promise<EnsuredCameraPath>>();
  private readonly pathEnsureCache = new Map<string, { value: EnsuredCameraPath; at: number }>();
  // Última autocura da grade por câmera: impede que um path genuinamente
  // quebrado (câmera que aceita sessão e não envia mídia) vire tempestade de
  // re-probe a cada request da grade.
  private readonly gridHealAt = new Map<string, number>();
  // Câmeras cuja GRADE comprovadamente emite faixa de metadados (visto pelo
  // MediaMTX, não pelo ffprobe). Alimenta a decisão de sanitização.
  private readonly gridHasGenericTrack = new Set<string>();

  // ── FREIO DE TRANSCODES SIMULTÂNEOS ────────────────────────────────────────
  //
  // Medido na simulação de capacidade (2026-08-03), nesta máquina de 15 núcleos:
  //
  //     H.264 passthrough .......... 1,3% de CPU por câmera
  //     H.265 → transcode H.264 .... 6,6% de CPU por câmera   (5× mais)
  //
  // Sem freio, um operador que abra um mural com 200 câmeras H.265 dispara 200
  // FFmpeg de uma vez. O servidor não recusa: ele aceita todos e entrega os 200
  // travando — e como o transcode fica mais lento que o tempo real, TODAS as
  // câmeras degradam juntas, inclusive as que já estavam boas.
  //
  // Degradar previsivelmente é melhor que colapsar: passado o teto, o tile novo
  // recebe uma recusa clara em vez de derrubar a experiência de quem já está
  // assistindo. O padrão sai da medição — ~10 transcodes por núcleo deixa a
  // máquina em ~66% de CPU só com transcode, com folga para gravação e IA.
  private activeTranscodes = 0;
  // Diagnósticos da frota consultavam somente o path base, embora a grade use
  // paths próprios. Isso gerava centenas de 404 no MediaMTX e informava zero
  // leitores com o mosaico aberto. Uma listagem curta, compartilhada entre as
  // câmeras do relatório, dá a visão correta sem transformar a sonda em carga.
  private runtimePathListCache: { at: number; items: any[] } | null = null;
  private runtimePathListInFlight: Promise<any[]> | null = null;
  private readonly maxTranscodes = envNumber(
    'MEDIAMTX_MAX_CONCURRENT_TRANSCODES',
    // Reserva CPU para API, banco, gravação e IA. Em máquinas pequenas o teto
    // antigo (10 por núcleo) aceitava conversões suficientes para saturar tudo.
    Math.max(4, (os.cpus()?.length ?? 4) * 5),
    { min: 1, max: 2000, integer: true },
  );
  private readonly maxTranscodePoints = envNumber('MEDIAMTX_MAX_TRANSCODE_POINTS', this.maxTranscodes, {
    min: 1, max: 2000, integer: true,
  });
  // AUTOCURA DA GRADE: DESLIGADA por padrão (restaura o comportamento de 21/07).
  //
  // Ela existe por um motivo real: Cam-03/09 aceitam o RTSP e nunca enviam mídia,
  // e sem ela o tile fica em 0 fps até o cache expirar (30 min). Mas o preço é
  // mexer na fonte COM O OPERADOR ASSISTINDO: se a re-sondagem decidir uma URL
  // diferente da atual, o path sofre delete+add e TODO leitor ativo cai na hora
  // — piscada em tile que estava perfeito. O sistema estável de 21/07 escolhia
  // o endpoint uma vez e não mexia mais.
  // Protege 2 câmeras e arrisca as outras 19: enquanto a oscilação não estiver
  // explicada, o padrão é não mexer. MEDIAMTX_GRID_AUTOHEAL=true religa.
  // Busca profunda de sub (degraus /media/videoN, subtype=2, N03) na ABERTURA do
  // tile. Desligada: o resultado é estável e pertence ao cadastro, não ao caminho
  // quente. Ver o bloco em chooseGridSource.
  // De onde a grade puxa a imagem. Ver GridSourcePolicy (live-delivery-profile.helper).
  private readonly gridSourcePolicy = parseGridSourcePolicy(process.env.GRID_SOURCE_PROFILE);
  // Câmeras já avisadas no log por stream 2 fora do formato (evita repetir a cada ensure).
  private readonly gridAspectMismatchLogged = new Set<string>();
  private readonly deepSubSearchEnabled =
    String(process.env.MEDIAMTX_DEEP_SUB_SEARCH ?? 'false').trim().toLowerCase() === 'true';
  private readonly gridAutoHealEnabled =
    String(process.env.MEDIAMTX_GRID_AUTOHEAL ?? 'false').trim().toLowerCase() === 'true';
  // Coletor de sessões WebRTC duplicadas. DESLIGADO por padrão.
  //
  // Ele agrupa sessões apenas pelo path e mantém a mais nova. O servidor não tem
  // como distinguir uma sessão órfã de um SEGUNDO OPERADOR legítimo — todos
  // chegam pelo IP do proxy. Então, com dois operadores na mesma câmera (ou duas
  // abas, ou um monitor mural), quem estava assistindo há mais de 15s é EXPULSO
  // a cada ciclo do watchdog. Isso é exatamente a piscada que ele deveria evitar.
  //
  // O vazamento que motivou o coletor foi corrigido na raiz, no player (fecha a
  // sessão anterior antes de assumir a nova). O coletor era cinto além do
  // suspensório — e o suspensório passou a apertar o pescoço.
  //
  // Continua disponível para diagnóstico de vazamento: MEDIAMTX_REAP_DUPLICATE_SESSIONS=true.
  private readonly reapDuplicateSessionsEnabled =
    String(process.env.MEDIAMTX_REAP_DUPLICATE_SESSIONS ?? 'false').trim().toLowerCase() === 'true';
  // Salto privado (`_source`) entre a câmera e o FFmpeg. DESLIGADO por padrão:
  // protegia a credencial no `ps aux`, mas o repasse extra custou FPS e tiles
  // pretos em produção. Ver o comentário em ensurePathForCamera.
  private readonly usePrivateSourceHop =
    String(process.env.MEDIAMTX_PRIVATE_SOURCE_HOP ?? 'false').trim().toLowerCase() === 'true';
  // TETO GLOBAL de `ffprobe` simultâneos (ver probeStreamVideoMetadata). Sem ele,
  // uma grade de 21 tiles com cache frio dispara até 105 sondas contra o mesmo
  // DVR e derruba a fonte que estava tentando descobrir. Ajustável por env para
  // instalação com DVR mais robusto (ou mais frágil) que o padrão.
  private readonly maxConcurrentProbes = envNumber('MEDIAMTX_MAX_CONCURRENT_PROBES', 4, {
    min: 1,
    max: 64,
    integer: true,
  });
  private activeProbes = 0;
  private readonly streamMetadataCache = new Map<string, { value: StreamMetadata | null; expires: number }>();
  private readonly streamMetadataInFlight = new Map<string, Promise<StreamMetadata | null>>();
  private readonly probeQueue: Array<() => void> = [];
  // ── VALIDADE DA DECISÃO DE FONTE ───────────────────────────────────────────
  //
  // Era 30 minutos, e isso colocava o ffprobe DENTRO da requisição do tile: o
  // operador que abrisse a grade meia hora depois da última vez pagava a
  // redescoberta inteira. Numa grade de 21 tiles com cache frio, as sondas
  // enfileiram (teto de 4 simultâneas, até 8s cada) — dezenas de segundos até a
  // primeira imagem, exatamente a demora relatada após restart da API.
  //
  // O prazo curto não protegia nada, porque a decisão NÃO expira por tempo: ela
  // é descartada por EVENTO. `invalidateMainCodecCache` é chamada quando o
  // watchdog recupera um path travado e quando o MediaMTX reporta faixa
  // inesperada — ou seja, quando a fonte realmente mudou. Encurtar o prazo só
  // adicionava re-sondagem cega contra o DVR do cliente.
  //
  // Seis horas cobrem um turno inteiro. Quem muda o cadastro da câmera continua
  // invalidando na hora, pelo caminho de evento.
  private static readonly LIVE_CODEC_TTL_MS =
    envNumber('MEDIAMTX_SOURCE_DECISION_TTL_MINUTES', 360, { min: 1, max: 10080, integer: true })
    * 60 * 1000;
  private static readonly PATH_ENSURE_TTL_MS = 30 * 1000;

  // Watchdog de stream: vigia paths de câmera com espectador mas SEM progresso de
  // vídeo (fonte congelada/ausente) e força reset. 3ª camada de segurança, além do
  // prekill no runOnDemand e do reaper de zumbis (tini). Conservador: só age após
  // ~60s de estagnação (bem além do cold start de ~15s), para nunca tocar em stream
  // saudável nem em cold start normal.
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private readonly watchdogState = new Map<string, { lastBytes: number; badTicks: number }>();
  private watchdogTickRunning = false;
  private readonly trackHealthState = new Map<string, { at: number; health: TrackPacketHealth; badVideo: number; badAudio: number }>();
  private static readonly WATCHDOG_INTERVAL_MS = 20_000;
  private static readonly WATCHDOG_BAD_TICKS = 3; // 3 × 20s = ~60s antes de agir
  private readonly recoveringPaths = new Set<string>();

  // ── FREIO ANTI-TEMPESTADE ──────────────────────────────────────────────────
  // Técnica derivada do Frigate (MIT) — Copyright (c) Frigate, Inc.
  // (frigate/watchdog.py: MAX_RESTARTS / RESTART_WINDOW_S + is_restarting_too_fast).
  //
  // Sem ele, câmera MORTA (fonte offline, link caído, obra na rua) = ciclo eterno:
  // a cada ~80s o watchdog apaga e recria o path, roda ffprobe e sobe FFmpeg de
  // novo — CPU queimada 24/7 por uma fonte que não vai voltar sozinha, e log
  // inundado justamente quando alguém precisa ler o log.
  //
  // Diferença deliberada do Frigate: aqui o freio só arma quando a recuperação é
  // FÚTIL. Se o path volta a progredir (bytes crescendo com espectador), a janela
  // é ZERADA em clearRecoveryBrake — câmera que realmente se recupera nunca é
  // freada. Falso positivo que deixa câmera boa sem live é pior que o sintoma.
  //
  // Sob freio o watchdog NÃO desiste: espera o resfriamento (crescente) e volta a
  // tentar. Nada é apagado, nada é desabilitado — só espaçamos as tentativas.
  private static readonly BRAKE_MAX_RECOVERIES = 5;
  private static readonly BRAKE_WINDOW_MS = 10 * 60_000;
  private static readonly BRAKE_BASE_COOLDOWN_MS = 2 * 60_000;
  private static readonly BRAKE_MAX_COOLDOWN_MS = 30 * 60_000;
  private readonly recoveryBrake = new Map<string, { attempts: number[]; cooldownUntil: number; level: number }>();

  // ── Fontes quentes da grade (por relevância, com orçamento) ───────────────
  // Visualizações de grade por câmera. Fonte da política computeHotGridSet:
  // quente = as `budget` mais recentes dentro da janela. Persistido (debounced)
  // em SystemSetting para sobreviver a restart — sem isso, todo deploy voltaria
  // a grade fria e pareceria regressão.
  private readonly gridViewAt = new Map<string, number>();
  private gridViewDirtyAt = 0;
  private gridViewPersistedAt = 0;
  private hotReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly HOT_GRID_HISTORY_KEY = 'live.gridViewHistory';
  private static readonly HOT_GRID_PERSIST_MIN_INTERVAL_MS = 60_000;
  private static readonly HOT_GRID_RECONCILE_INTERVAL_MS = 5 * 60_000;

  constructor(
    private readonly configService: ConfigService,
    private readonly camerasService: CamerasService,
    private readonly cryptoService: CryptoService,
    // Opcional de propósito: o gateway é uma camada nova e DESLIGADA por default.
    // Sendo opcional, este serviço continua instanciável (inclusive nos testes que
    // o constroem à mão) sem conhecer o gateway.
    @Optional() private readonly sourceGateway?: SourceGatewayService,
    // Opcional pelo mesmo motivo dos testes; em produção o PrismaModule é
    // @Global e o Nest injeta. Sem ele, o histórico só não é persistido.
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly rtmpIngestSource?: RtmpIngestSourceService,
    @Optional() private readonly sharedRtspSource?: SharedRtspSourceService,
  ) {}

  private hotGridBudget(): number {
    return envNumber('MEDIAMTX_HOT_GRID_SOURCES_MAX', DEFAULT_HOT_GRID_BUDGET, {
      min: 0,
      max: 4096,
      integer: true,
      onInvalid: (m) => this.logger.warn(m),
    });
  }

  private hotGridWindowMs(): number {
    return envNumber('MEDIAMTX_HOT_GRID_WINDOW_HOURS', DEFAULT_HOT_GRID_WINDOW_HOURS, {
      min: 1,
      max: 24 * 90,
      integer: true,
      onInvalid: (m) => this.logger.warn(m),
    }) * 3600_000;
  }

  /** Registro de que um ESPECTADOR pediu a grade desta câmera agora. */
  markGridViewed(cameraId: string) {
    this.gridViewAt.set(cameraId, Date.now());
    this.gridViewDirtyAt = Date.now();
    void this.persistGridViewHistory().catch(() => undefined);
  }

  /**
   * O path da GRADE desta câmera deve ficar SOB DEMANDA?
   *
   * Quem decide é o ORÇAMENTO QUENTE, por câmera — não uma env global.
   *
   * Antes isto vinha direto de `mediaMtxSourceOnDemand`, e com
   * `MEDIAMTX_SOURCE_ON_DEMAND=false` (produção) TODO path configurado nascia
   * sempre-conectado. Como o aquecimento de boot configura todos os habilitados,
   * a premissa que o justifica — "path sob demanda não abre conexão ao ser
   * configurado" — deixava de valer, e aquecer 22 câmeras virava 22 sessões
   * RTSP permanentes.
   *
   * Medido em produção em 2026-08-01: 4 paths prontos com ZERO espectadores,
   * 1,7 GB em 8 minutos — ~304 GB/dia de banda WAN paga para ninguém, além de
   * 4 sessões presas nas câmeras (o recurso que a câmera barata limita a 2–4).
   *
   * O orçamento já existia e estava em 0, mas `reconcileHotGridSources` só age
   * em paths `_grid_source`, que sumiram quando o salto privado virou opt-in
   * (revert fdc79ff): o controle olhava para um path que a produção não tem.
   *
   * `isGridSourceHot` já respeita `MEDIAMTX_SOURCE_ON_DEMAND=true` como decisão
   * explícita do operador ("tudo sob demanda"), então essa escolha continua
   * vencendo o orçamento.
   */
  private resolveGridSourceOnDemand(cameraId: string): boolean {
    return !this.isGridSourceHot(cameraId);
  }

  private isGridSourceHot(cameraId: string): boolean {
    // Env explícita vence: operador que setou "tudo sob demanda" quis isso.
    if (this.configService.get<boolean>('mediaMtxSourceOnDemand') === true) return false;
    const hot = computeHotGridSet(
      [...this.gridViewAt.entries()].map(([id, at]) => ({ cameraId: id, lastViewedAt: at })),
      this.hotGridBudget(),
      this.hotGridWindowMs(),
      Date.now(),
    );
    return hot.has(cameraId);
  }

  private async loadGridViewHistory() {
    if (!this.prisma) return;
    try {
      const row = await this.prisma.systemSetting.findUnique({
        where: { key: MediamtxProxyService.HOT_GRID_HISTORY_KEY },
      });
      const parsed: GridViewEntry[] = row?.value ? JSON.parse(row.value) : [];
      for (const e of pruneHistory(parsed, this.hotGridWindowMs(), Date.now())) {
        this.gridViewAt.set(e.cameraId, e.lastViewedAt);
      }
    } catch {
      // Histórico ilegível = começa vazio; a semente abaixo cobre.
    }
    if (this.gridViewAt.size === 0) {
      // Primeiro boot com esta política: sem semente, a grade inteira nasceria
      // fria e o operador leria a atualização como regressão. O orçamento corta
      // no teto, então instalação gigante não aquece a frota toda.
      try {
        const cameras = (await this.camerasService.findAllInternal())
          .filter((camera) => (camera as { enabled?: boolean }).enabled !== false);
        for (const e of seedEmptyHistory(cameras.map((c) => c.id), Date.now())) {
          this.gridViewAt.set(e.cameraId, e.lastViewedAt);
        }
      } catch {
        // Sem câmeras legíveis não há o que semear.
      }
    }
  }

  private async persistGridViewHistory(force = false) {
    if (!this.prisma) return;
    const agora = Date.now();
    if (!force && agora - this.gridViewPersistedAt < MediamtxProxyService.HOT_GRID_PERSIST_MIN_INTERVAL_MS) return;
    if (this.gridViewDirtyAt <= this.gridViewPersistedAt) return;
    this.gridViewPersistedAt = agora;
    const podado = pruneHistory(
      [...this.gridViewAt.entries()].map(([id, at]) => ({ cameraId: id, lastViewedAt: at })),
      this.hotGridWindowMs(),
      agora,
    );
    const value = JSON.stringify(podado);
    await this.prisma.systemSetting.upsert({
      where: { key: MediamtxProxyService.HOT_GRID_HISTORY_KEY },
      create: { key: MediamtxProxyService.HOT_GRID_HISTORY_KEY, value },
      update: { value },
    }).catch(() => undefined);
  }

  /**
   * Reconciliação periódica quente↔frio.
   *
   * A decisão no ensure só vale para a câmera sendo aberta; quem ESFRIOU (saiu
   * do orçamento ou da janela) precisa de alguém que desligue a fonte — senão
   * o "quente por relevância" degenera de novo em "quente para sempre".
   */
  private async reconcileHotGridSources() {
    if (!this.isEnabled()) return;
    try {
      const [configText, runtimeText] = await Promise.all([
        this.apiRequest('GET', '/v3/config/paths/list?itemsPerPage=1000'),
        this.apiRequest('GET', '/v3/paths/list?itemsPerPage=1000'),
      ]);
      const items: any[] = JSON.parse(configText)?.items ?? [];
      const runtimeItems: any[] = JSON.parse(runtimeText)?.items ?? [];
      const readersByPath = new Map<string, number>(runtimeItems.map((item: any) => [
        String(item?.name ?? ''),
        Array.isArray(item?.readers) ? item.readers.length : Number(item?.readers ?? 0),
      ]));
      for (const item of items) {
        const name: string = item?.name ?? '';
        const publicName = name.endsWith('_source') ? name.replace(/_source$/, '') : name;
        const parsed = this.cameraIdFromPathName(publicName);
        if (!parsed) continue;
        if (parsed.deliveryMode !== 'grid' && parsed.deliveryMode !== 'grid-hevc') continue;
        // `grid-hevc` é a fonte bruta canônica (H.265 ou H.264, como veio da
        // câmera). `grid` é somente a contingência H.264. Manter os dois quentes
        // abre DUAS sessões RTSP por câmera e esgota DVRs/OEMs rapidamente.
        // Publisher não aceita sourceOnDemand: runOnDemand já o controla.
        if (String(item?.source ?? '') === 'publisher') continue;
        const desiredOnDemand = parsed.deliveryMode === 'grid'
          ? true
          : !this.isGridSourceHot(parsed.cameraId);
        if (item.sourceOnDemand === desiredOnDemand) continue;
        // Não altera a configuração por baixo de quem está assistindo. Assim
        // que o último leitor sair, o ciclo seguinte esfria o fallback.
        if ((readersByPath.get(name) ?? 0) > 0) continue;
        await this.apiRequest(
          'PATCH',
          `/v3/config/paths/patch/${encodeURIComponent(name)}`,
          { sourceOnDemand: desiredOnDemand },
        ).catch(() => undefined);
        this.logger.log(
          `Fonte da grade ${name} → ${desiredOnDemand ? 'sob demanda (esfriou)' : 'sempre conectada (aqueceu)'}.`,
        );
      }
    } catch {
      // Próximo ciclo tenta de novo; reconciliação nunca pode derrubar nada.
    }
  }

  onApplicationBootstrap() {
    if (!this.isEnabled()) return;

    this.assertStrongApiCredentials();

    // Histórico primeiro, aquecimento depois: o warm-up decide O QUE aquecer a
    // partir do conjunto quente, que depende do histórico carregado.
    void this.loadGridViewHistory().then(() => {
      if (this.configService.get<boolean>('mediaMtxWarmPathsOnBoot') !== false) {
        void this.warmCameraPaths();
      }
    });
    this.hotReconcileTimer = setInterval(() => {
      void this.reconcileHotGridSources();
      void this.persistGridViewHistory().catch(() => undefined);
    }, MediamtxProxyService.HOT_GRID_RECONCILE_INTERVAL_MS);
    this.hotReconcileTimer.unref?.();

    // O watchdog é independente do warm-on-boot: queremos a vigilância sempre que
    // o MediaMTX está habilitado.
    if (this.configService.get<boolean>('mediaMtxWatchdogEnabled') !== false) {
      this.watchdogTimer = setInterval(() => {
        void this.streamWatchdogTick();
        void this.reapDuplicateWebrtcSessions();
      }, MediamtxProxyService.WATCHDOG_INTERVAL_MS);
      // unref: o timer não deve impedir o processo de encerrar.
      this.watchdogTimer.unref?.();
      this.logger.log('Watchdog de stream ativo (intervalo 20s, reset após ~60s de estagnação).');
    }
  }

  onModuleDestroy() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.hotReconcileTimer) {
      clearInterval(this.hotReconcileTimer);
      this.hotReconcileTimer = null;
    }
    // Última chance de gravar o histórico: perder as visualizações da sessão
    // faria a grade nascer meio fria no próximo boot.
    void this.persistGridViewHistory(true).catch(() => undefined);
  }

  /**
   * Um ciclo do watchdog: lê o estado em runtime de todos os paths e, para cada
   * path de câmera COM espectador mas sem progresso de bytes (fonte congelada) ou
   * sem fonte pronta, conta "ticks ruins". Após WATCHDOG_BAD_TICKS seguidos, força
   * o reset daquele path (DELETE + recriação), que sobe um restream novo e limpo.
   */
  /**
   * O MediaMTX guarda os paths criados por API apenas em memória: se o container
   * for recriado (upgrade de imagem, `compose up` que reavalia o serviço, OOM),
   * ele volta VAZIO — e o `pathEnsureCache` daqui continua achando que os paths
   * existem, então nada os recria. Resultado observado em produção 2026-07-21:
   * MediaMTX recriado às 21:19 → paths sumiram → live morto para TODAS as câmeras
   * até alguém reiniciar a API (o warm-on-boot era a única cura).
   *
   * Aqui o watchdog reconcilia sozinho: se o MediaMTX tem MUITO menos paths do que
   * as câmeras habilitadas exigem, limpa o cache e re-aquece. Barato (1 request por
   * tick) e cobre o modo de falha real.
   */
  private async reconcileMissingPaths(activePathNames: Set<string>) {
    try {
      const cameras = await this.camerasService.findAllInternal();
      const expected = cameras.filter((cam: any) => cam.enabled !== false);
      if (!expected.length) return;

      // A grade web atual usa a rota H.264 compatível. Conferir `grid-hevc`
      // aqui faria o watchdog recriar uma segunda sessão RTSP por câmera mesmo
      // depois de a interface ter escolhido corretamente a rota compatível.
      const missing = expected.filter((cam: any) => !activePathNames.has(this.pathNameFromCameraId(cam.id, 'grid')));
      // Tolerância: só age quando a maioria sumiu (assinatura de MediaMTX zerado).
      // Uma câmera isolada sem path é normal (on-demand/erro pontual) e já é
      // tratada pelo fluxo de ensurePathForCamera quando alguém abre a câmera.
      if (missing.length < Math.max(2, Math.ceil(expected.length * 0.5))) return;

      this.logger.warn(
        `MediaMTX está sem ${missing.length}/${expected.length} paths de grade (provável recriação do container). Re-aquecendo...`,
      );
      this.pathEnsureCache.clear();
      await this.warmCameraPaths();
    } catch (error) {
      this.logger.warn(`Falha ao reconciliar paths do MediaMTX: ${(error as Error).message}`);
    }
  }

  private async streamWatchdogTick() {
    if (this.watchdogTickRunning) return;
    this.watchdogTickRunning = true;
    try { await this.runStreamWatchdogTick(); }
    finally { this.watchdogTickRunning = false; }
  }

  private async runStreamWatchdogTick() {
    let items: any[] = [];
    try {
      const text = await this.apiRequest('GET', '/v3/paths/list?itemsPerPage=1000');
      const data = JSON.parse(text);
      items = Array.isArray(data?.items) ? data.items : [];
    } catch {
      return; // MediaMTX indisponível neste tick; tenta no próximo.
    }

    await this.reconcileMissingPaths(new Set(items.map((item: any) => String(item?.name ?? ''))));

    // Conta os transcodes VIVOS aqui, aproveitando a listagem que o watchdog já
    // faz. Contar sob demanda, na criação de cada path, colocaria uma consulta ao
    // MediaMTX no caminho quente do tile — exatamente o que tiramos de lá ao mover
    // o ffprobe para fora. O número fica alguns segundos velho, e isso basta: ele
    // serve de FREIO, não de contabilidade exata.
    this.activeTranscodes = items.filter(isManagedLivePublisher).length;

    const seen = new Set<string>();
    const stuck: Array<{ name: string; ready: boolean; readers: number }> = [];
    for (const item of items) {
      const name: string = item?.name ?? '';
      if (!name.startsWith('cam_')) continue;
      seen.add(name);

      const ready = Boolean(item?.ready);
      const readers = Array.isArray(item?.readers) ? item.readers.length : Number(item?.readers ?? 0);
      const bytes = Number(item?.bytesReceived ?? 0);

      // Faixa de metadados: quem enxerga é o MediaMTX, não o ffprobe.
      //
      // A sanitização decidia pelo `hasDataTrack` do probe contra a câmera — e
      // MEDIDO em produção: na Cam-01 esse probe volta SEM a faixa, enquanto o
      // MediaMTX, na sessão contínua, reporta `Generic` e registra "unknown
      // payload type" 30 vezes por minuto. A decisão ficava presa em passthrough
      // e o log seguia inundado (afogando erro real numa investigação).
      // O laço do watchdog já lê a lista inteira de paths a cada tick: aproveita
      // o dado autoritativo daqui e ensina a decisão para o próximo ensure.
      this.noteGenericTrack(name, ready, Array.isArray(item?.tracks) ? item.tracks : []);

      // Sem espectador → nada a vigiar (cold close é normal).
      if (readers <= 0) {
        this.watchdogState.delete(name);
        continue;
      }

      const prev = this.watchdogState.get(name) ?? { lastBytes: -1, badTicks: 0 };
      // "Ruim" = sem fonte pronta, OU pronto porém sem bytes novos desde o último
      // tick (fonte congelada). A primeira observação nunca conta como ruim.
      const noProgress = prev.lastBytes < 0 ? false : ready ? bytes <= prev.lastBytes : true;
      const badTicks = noProgress ? prev.badTicks + 1 : 0;
      this.watchdogState.set(name, { lastBytes: bytes, badTicks });

      // PROVA de saúde (bytes novos com fonte pronta): a recuperação anterior
      // funcionou de verdade, então a janela do freio é zerada. Sem isto, uma
      // câmera intermitente porém CURÁVEL acabaria freada por acumular resets.
      if (prev.lastBytes >= 0 && ready && bytes > prev.lastBytes
        && !['missing', 'stalled'].includes(this.trackHealthState.get(name)?.health.video ?? '')
        && !['missing', 'stalled'].includes(this.trackHealthState.get(name)?.health.audio ?? '')) {
        this.clearRecoveryBrake(name);
      }

      if (badTicks >= MediamtxProxyService.WATCHDOG_BAD_TICKS) {
        this.watchdogState.delete(name);
        stuck.push({ name, ready, readers });
      }
    }

    // Four packet-only samples per tick, round-robin, only for existing viewers.
    // Reading the internal path reuses its source and does not decode video.
    const candidates = items.filter(item => item.ready && Array.isArray(item.readers) && item.readers.length
      && this.cameraIdFromPathName(String(item.name)) && Array.isArray(item.tracks) && item.tracks.length)
      .sort((a, b) => (this.trackHealthState.get(a.name)?.at ?? 0) - (this.trackHealthState.get(b.name)?.at ?? 0))
      .slice(0, 4);
    if (String(process.env.MEDIAMTX_TRACK_HEALTH_ENABLED ?? 'true') === 'true') {
      await Promise.all(candidates.map(async item => {
        const health = await this.sampleTrackHealth(item.name, item.tracks);
        const previous = this.trackHealthState.get(item.name);
        const badVideo = ['missing', 'stalled'].includes(health.video) ? (previous?.badVideo ?? 0) + 1 : 0;
        const badAudio = ['missing', 'stalled'].includes(health.audio) ? (previous?.badAudio ?? 0) + 1 : 0;
        this.trackHealthState.set(item.name, { at: Date.now(), health, badVideo, badAudio });
        if (badAudio === 3) this.logger.warn(`Trilha de áudio sem progresso em ${item.name}; vídeo=${health.video}.`);
        if ((badVideo >= 3 || badAudio >= 3) && !stuck.some(x => x.name === item.name)) {
          stuck.push({ name: item.name, ready: true, readers: item.readers.length });
          this.trackHealthState.set(item.name, { at: Date.now(), health, badVideo: 0, badAudio: 0 });
        }
      }));
    }
    for (const key of this.trackHealthState.keys()) if (!seen.has(key)) this.trackHealthState.delete(key);
    // Recupera os paths travados em PARALELO (limite interno), não um a um.
    await this.recoverStuckPaths(stuck);

    // Limpa estado de paths que não existem mais.
    for (const key of [...this.watchdogState.keys()]) {
      if (!seen.has(key)) this.watchdogState.delete(key);
    }
    // Idem para o freio: path que sumiu do MediaMTX não pode deixar estado para
    // trás (a API roda meses sem reiniciar — Map sem poda é vazamento).
    for (const key of [...this.recoveryBrake.keys()]) {
      if (!seen.has(key)) this.recoveryBrake.delete(key);
    }
  }

  private sampleTrackHealth(pathName: string, tracks: string[]): Promise<TrackPacketHealth> {
    const unknown: TrackPacketHealth = { video: 'unknown', audio: 'unknown' };
    const url = this.buildInternalRtspUrl(pathName);
    if (!url) return Promise.resolve(unknown);
    return new Promise(resolve => {
      let settled = false;
      let output = '';
      const finish = (health: TrackPacketHealth) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(health);
      };
      const timer = setTimeout(() => { process?.kill('SIGKILL'); finish(unknown); }, 7000);
      timer.unref();
      let process: ReturnType<typeof spawnWithSecretUrl>;
      try {
        process = spawnWithSecretUrl('ffprobe', [
          '-v', 'error', '-rtsp_transport', 'tcp', '-timeout', '3000000',
          '-analyzeduration', '500000', '-probesize', '262144', '-read_intervals', '%+2',
          '-show_packets', '-show_entries', 'packet=codec_type,pts_time,dts_time', '-of', 'json', url,
        ], url);
        process.stderr?.resume();
        process.stdout?.on('data', chunk => {
          output += chunk.toString();
          if (output.length > 1_000_000) { process.kill('SIGKILL'); finish(unknown); }
        });
        process.once('error', () => finish(unknown));
        process.once('close', code => finish(code === 0 ? trackPacketHealth(output, tracks) : unknown));
      } catch { finish(unknown); }
    });
  }

  /** Relógio do freio — costura de teste (produção usa o relógio do sistema). */
  private nowMs(): number {
    return Date.now();
  }

  /**
   * true → este path está em RESFRIAMENTO: não tentar recuperar agora.
   * Ao vencer o resfriamento, libera com a janela limpa (mas guarda o NÍVEL: se
   * a fonte continuar morta, o próximo freio é mais longo).
   */
  private isRecoveryBraked(pathName: string): boolean {
    const entry = this.recoveryBrake.get(pathName);
    if (!entry || entry.cooldownUntil <= 0) return false;
    const now = this.nowMs();
    if (now < entry.cooldownUntil) return true;
    entry.cooldownUntil = 0;
    entry.attempts.length = 0;
    this.logger.warn(`Watchdog: resfriamento de ${pathName} terminou — voltando a tentar recuperar.`);
    return false;
  }

  /**
   * Registra a tentativa e ARMA o freio quando N recuperações caem na janela.
   * Equivale ao deque(maxlen) + popleft do Frigate: a janela desliza, tentativas
   * antigas não contam.
   */
  private noteRecoveryAttempt(pathName: string, cameraId: string): void {
    const now = this.nowMs();
    const entry = this.recoveryBrake.get(pathName) ?? { attempts: [], cooldownUntil: 0, level: 0 };
    this.recoveryBrake.set(pathName, entry);

    // Janela DESLIZANTE: descarta tentativas mais velhas que a janela antes de
    // contar. Sem isto, uma câmera que cai de vez em quando acumularia tentativas
    // para sempre e acabaria freada — e armar o freio dispara alerta ("a fonte não
    // volta sozinha, manda alguém no local"). Chamado falso destrói a confiança no
    // alerta, então intermitente NÃO pode ser confundida com fonte morta.
    // Equivale ao deque(maxlen)+popleft do Frigate (watchdog.py).
    const janelaInicio = now - MediamtxProxyService.BRAKE_WINDOW_MS;
    entry.attempts = entry.attempts.filter((at) => at > janelaInicio);

    entry.attempts.push(now);
    if (entry.attempts.length < MediamtxProxyService.BRAKE_MAX_RECOVERIES) return;

    entry.level += 1;
    const cooldownMs = Math.min(
      MediamtxProxyService.BRAKE_MAX_COOLDOWN_MS,
      MediamtxProxyService.BRAKE_BASE_COOLDOWN_MS * 2 ** (entry.level - 1),
    );
    entry.cooldownUntil = now + cooldownMs;
    entry.attempts.length = 0;

    this.logger.error(
      `Watchdog: FREIO ANTI-TEMPESTADE em ${pathName} — ${MediamtxProxyService.BRAKE_MAX_RECOVERIES} recuperações ` +
        `em ${Math.round(MediamtxProxyService.BRAKE_WINDOW_MS / 60_000)} min sem a fonte voltar. Pausando novas ` +
        `tentativas por ${Math.round(cooldownMs / 1000)}s (nível ${entry.level}). A câmera provavelmente está ` +
        `offline de verdade: verifique link/energia no local. Gravação e demais câmeras seguem intactas.`,
    );
    try {
      cameraMetrics.recordStreamRecoveryBrake(cameraId);
    } catch { /* observabilidade nunca interrompe o watchdog */ }
  }

  /** Path provado saudável (ou inexistente): zera janela E escalonamento. */
  private clearRecoveryBrake(pathName: string): void {
    this.recoveryBrake.delete(pathName);
  }

  /**
   * Registra que a GRADE desta câmera carrega faixa de metadados.
   *
   * Só marca a partir do que o MediaMTX de fato recebeu (path pronto), nunca de
   * palpite. É de mão única: uma vez sabido que a câmera emite a faixa, a
   * decisão seguinte já nasce sanitizando — sem ficar alternando entre
   * passthrough e remux a cada tick, que faria a live piscar.
   */
  private noteGenericTrack(pathName: string, ready: boolean, tracks: unknown[]) {
    if (!ready || (!pathName.endsWith('_grid') && !pathName.endsWith('_grid_audio'))) return;
    const parsed = this.cameraIdFromPathName(pathName);
    if (!parsed) return;
    const hasGeneric = tracks.some((t) => /generic/i.test(String(t)));
    if (!hasGeneric || this.gridHasGenericTrack.has(parsed.cameraId)) return;
    this.gridHasGenericTrack.add(parsed.cameraId);
    // Descoberta nova: descarta a decisão antiga para que o próximo ensure já
    // suba o remux que descarta a faixa.
    this.invalidateMainCodecCache(parsed.cameraId);
    this.logger.log(
      `Grade de ${parsed.cameraId}: faixa de metadados detectada pelo MediaMTX — passará a ser descartada no remux.`,
    );
  }

  /**
   * Derruba sessão WebRTC DUPLICADA da mesma câmera — rede de segurança.
   *
   * O vazamento nasce no cliente (uma reconexão que não fecha a sessão anterior),
   * e lá ele foi corrigido. Mas o CUSTO de uma falha dessas recai inteiro sobre o
   * servidor: cada duplicata é o MESMO vídeo saindo outra vez pelo uplink.
   * MEDIDO em produção: 17 câmeras viravam 30 sessões, a subida saturava em
   * 33 Mbps e TODOS os tiles caíam juntos — com CPU ociosa, o que despistava o
   * diagnóstico para o lado errado.
   *
   * Por isso o servidor não confia no cliente: se há mais de uma sessão viva
   * para o mesmo path, mantém a MAIS NOVA (é a que o operador está de fato
   * vendo) e encerra as anteriores. Navegador antigo, aba esquecida ou bug
   * futuro deixam de virar saturação de link.
   *
   * Só age em duplicata do MESMO path. Espectadores diferentes na MESMA câmera
   * são um caso legítimo — e indistinguíveis daqui, já que todos chegam pelo IP
   * do proxy — então a janela de graça evita matar quem acabou de conectar.
   */
  private async reapDuplicateWebrtcSessions() {
    if (!this.isEnabled()) return;
    if (!this.reapDuplicateSessionsEnabled) return;
    const GRACA_MS = 15_000;
    try {
      const texto = await this.apiRequest('GET', '/v3/webrtcsessions/list?itemsPerPage=1000');
      const itens = (JSON.parse(texto) as { items?: Array<Record<string, any>> }).items ?? [];
      const porPath = new Map<string, Array<Record<string, any>>>();
      for (const s of itens) {
        const path = String(s?.path ?? '');
        if (!path.startsWith('cam_')) continue;
        const lista = porPath.get(path) ?? [];
        lista.push(s);
        porPath.set(path, lista);
      }
      const agora = Date.now();
      for (const [path, sessoes] of porPath) {
        if (sessoes.length < 2) continue;
        // Mais nova primeiro: ela é a que fica.
        sessoes.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
        for (const antiga of sessoes.slice(1)) {
          const idade = agora - new Date(antiga.created).getTime();
          if (idade < GRACA_MS) continue;
          const id = String(antiga.id ?? '');
          if (!id) continue;
          await this.apiRequest('POST', `/v3/webrtcsessions/kick/${encodeURIComponent(id)}`)
            .then(() => {
              this.logger.warn(
                `Sessão WebRTC duplicada encerrada em ${path} (idade ${Math.round(idade / 1000)}s) — o mesmo vídeo saía duas vezes pelo uplink.`,
              );
            })
            .catch(() => undefined);
        }
      }
    } catch {
      // Falha aqui nunca pode interromper o watchdog.
    }
  }

  private async recoverStuckPaths(stuck: Array<{ name: string; ready: boolean; readers: number }>) {
    // Recupera em PARALELO com limite (antes: serial, uma de cada vez). Uma fleet
    // inteira travada reconstitui em ~max(tempo de 1 recuperação) × ceil(N/limite),
    // não na SOMA das recuperações. O limite evita uma tempestade de reconfigurações.
    const CONCURRENCY = 4;
    for (let i = 0; i < stuck.length; i += CONCURRENCY) {
      await Promise.all(
        stuck.slice(i, i + CONCURRENCY).map((s) => this.recoverStuckPath(s.name, s.ready, s.readers)),
      );
    }
  }

  private async recoverStuckPath(pathName: string, ready: boolean, readers: number) {
    // Os paths PRIVADOS (`..._source`) são justamente os que seguram a conexão
    // RTSP com a câmera; o público que depende deles seca junto quando um trava.
    // O scan já os coletava (filtra só por `cam_`), mas o parser só conhece o
    // nome público e devolvia null — então o watchdog DESISTIA em silêncio de
    // recuperar exatamente o path que importa. Tira o sufixo para descobrir a
    // câmera: o DELETE abaixo continua removendo o path travado de verdade
    // (`pathName`), e recuperar o público recria o privado (ensurePrivateSourcePath
    // cria quando ausente, e invalidateMainCodecCache já limpou o pathEnsureCache).
    const parsed = this.cameraIdFromPathName(pathName.replace(/_source$/, ''));
    if (!parsed) return;
    // Guard POR-PATH: evita recuperar o MESMO path duas vezes em paralelo (entre
    // ticks). Paths DIFERENTES recuperam concorrentemente (ver recoverStuckPaths).
    if (this.recoveringPaths.has(pathName)) return;
    // Freio anti-tempestade: em resfriamento, nem tenta (o log do freio já
    // explicou o porquê; aqui seria só ruído a cada tick).
    if (this.isRecoveryBraked(pathName)) {
      this.logger.debug?.(`Watchdog: ${pathName} em resfriamento do freio anti-tempestade — pulando.`);
      return;
    }
    this.noteRecoveryAttempt(pathName, parsed.cameraId);
    this.recoveringPaths.add(pathName);
    this.logger.warn(
      `Watchdog: path travado ${pathName} (ready=${ready}, readers=${readers}, sem progresso) — forçando reset.`,
    );
    try {
      this.invalidateMainCodecCache(parsed.cameraId);
      const encoded = encodeURIComponent(pathName);
      if (/_raw_[a-f0-9]{24}_source$/.test(pathName) && this.sharedRtspSource) {
        await this.sharedRtspSource.restart(pathName);
      } else {
        await this.apiRequest('DELETE', `/v3/config/paths/delete/${encoded}`).catch(() => undefined);
        await this.ensurePathForCamera(parsed.cameraId, parsed.deliveryMode);
      }
      this.logger.log(`Watchdog: path ${pathName} reconfigurado com sucesso.`);
      // Métrica (aditiva): só conta recuperação que DEU CERTO — o caminho de
      // falha cai no catch abaixo e não infla o contador.
      try {
        cameraMetrics.recordStreamRecovery(parsed.cameraId);
      } catch { /* observabilidade nunca interrompe a recuperação */ }
    } catch (error) {
      this.logger.error(
        `Watchdog: falha ao recuperar ${pathName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.recoveringPaths.delete(pathName);
    }
  }

  /** Inverte pathNameFromCameraId: `cam_<32hex>[_grid|_grid_audio|_grid_hevc|_orig|_orig_audio]` → câmera/modo. */
  private cameraIdFromPathName(pathName: string): { cameraId: string; deliveryMode: LiveViewMode } | null {
    const match = pathName.match(/^cam_([0-9a-fA-F]{32})(_grid|_grid_audio|_grid_hevc|_orig|_orig_audio|_raw_[a-f0-9]{24}(?:_source)?)?$/);
    if (!match) return null;
    const h = match[1];
    const cameraId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    return {
      cameraId,
      deliveryMode: match[2] === '_grid'
        ? 'grid'
        : match[2] === '_grid_audio'
          ? 'grid-audio'
        : match[2] === '_grid_hevc'
          ? 'grid-hevc'
        : match[2] === '_orig'
          ? 'original'
          : match[2] === '_orig_audio'
            ? 'original-audio'
            : 'original',
    };
  }

  /**
   * MEDIAMTX_API_PASS era o ÚNICO segredo sem validação de força (JWT_SECRET,
   * CAMERA_SECRET_KEY e INTERNAL_SERVICE_TOKEN já falham no boot com valor default/curto).
   * Como o .env.example traz `change_me_mediamtx_pass` e o compose só exige que a var
   * exista, uma instalação que copiasse o exemplo subia com credencial pública conhecida —
   * e essa credencial libera read/publish em QUALQUER câmera no MediaMTX.
   */
  private assertStrongApiCredentials() {
    const user = (this.configService.get<string>('mediaMtxApiUser') ?? '').trim();
    const pass = (this.configService.get<string>('mediaMtxApiPass') ?? '').trim();
    const callbackToken = (
      this.configService.get<string>('mediaMtxAuthCallbackToken') ?? ''
    ).trim();
    // O USUÁRIO não é segredo: basta existir e não ser o valor de exemplo (não exigir
    // tamanho — nomes curtos como "nexusguard" são legítimos). A SENHA é o segredo.
    if (!user || user.startsWith('change_me')) {
      throw new Error('MEDIAMTX_API_USER inválido. Defina um usuário e não use o valor de exemplo (change_me_*).');
    }
    if (!pass || pass.startsWith('change_me') || pass.length < 24) {
      throw new Error(
        'MEDIAMTX_API_PASS inválida. Defina um segredo forte (>= 24 chars) e não use o valor de exemplo (change_me_*).',
      );
    }
    if (
      !/^[a-f0-9]{48,128}$/i.test(callbackToken)
      || callbackToken.startsWith('change_me')
    ) {
      throw new Error(
        'MEDIAMTX_AUTH_CALLBACK_TOKEN inválido. Defina um token hexadecimal dedicado com pelo menos 24 bytes.',
      );
    }
  }

  isEnabled() {
    return this.configService.get<boolean>('mediaMtxEnabled') !== false;
  }

  private sanitizeRtspUrl(url: string) {
    return sanitizeSensitiveText(url);
  }

  private buildInternalPublishRtspUrl(pathName = '$MTX_PATH') {
    return `rtsp://127.0.0.1:$RTSP_PORT/${pathName}`;
  }

  private shellQuote(value: string) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  // Público para o Source Gateway: consumidores precisam saber o NOME do path
  // interno daquela câmera/perfil para pedir a URL republicada. Só leitura — a
  // função é pura (deriva o nome do id), não cria nem altera path nenhum.
  pathNameFromCameraId(cameraId: string, deliveryMode: LiveViewMode = 'original') {
    const base = `cam_${cameraId.replace(/[^a-zA-Z0-9]/g, '')}`;
    if (deliveryMode === 'grid') return `${base}_grid`;
    if (deliveryMode === 'grid-audio') return `${base}_grid_audio`;
    if (deliveryMode === 'grid-hevc') return `${base}_grid_hevc`;
    if (deliveryMode === 'original-audio') return `${base}_orig_audio`;
    return `${base}_orig`;
  }

  private privateSourcePathName(pathName: string) {
    return `${pathName}_source`;
  }

  private async ensurePrivateSourcePath(
    pathName: string,
    sourceUrl: string,
    rtspTransport: string,
    sourceOnDemandStartTimeout: string,
    sourceOnDemandCloseAfter: string,
  ) {
    const sourcePathName = this.privateSourcePathName(pathName);
    const encoded = encodeURIComponent(sourcePathName);
    // A REGRESSÃO DO "PRIMEIRO ACESSO LENTO" morava aqui: `sourceOnDemand: true`
    // CRAVADO, ignorando MEDIAMTX_SOURCE_ON_DEMAND — que nesta instalação é
    // `false` de propósito. Antes do Source Gateway (24/07) a fonte da grade
    // ficava SEMPRE conectada à câmera: abrir um tile era só negociar o WebRTC
    // (~2s). Com o on-demand cravado, cada tile frio passou a pagar a conexão
    // WAN inteira (até 6s) + probe + keyframe — os ~30s reclamados em produção.
    //
    // SÓ A GRADE pode ficar quente, e isso não é detalhe: a primeira versão
    // desta correção aplicava a env a TODAS as fontes privadas, incluindo as
    // de tela-cheia — que puxam o STREAM PRINCIPAL (~2,1 Mbps cada). Bastou o
    // operador ter aberto duas câmeras em tela cheia uma vez para 4,2 Mbps de
    // mains ficarem pendurados SEM espectador, somando-se aos ~5,4 Mbps dos
    // subs e saturando o uplink do DVR do cliente — tiles caíam para 1 fps e
    // ficavam pretos ~1 min depois de abrir. O main é caro e tela-cheia é
    // ocasional: sob demanda, sempre.
    //
    // E "quente" para a grade não é mais tudo-ou-nada: é POR RELEVÂNCIA, com
    // orçamento (ver hot-grid-sources.helper.ts). Quente para todas as 21
    // câmeras desta instalação cabe no orçamento default; quente para 2.000
    // seria nós atacando os DVRs da própria frota.
    const isGridSource = pathName.endsWith('_grid') || pathName.endsWith('_grid_audio') || pathName.endsWith('_grid_hevc');
    const parsedForHot = isGridSource ? this.cameraIdFromPathName(pathName) : null;
    // Só a fonte bruta canônica (`grid-hevc`) pode ficar aquecida. A
    // contingência `grid` é sempre sob demanda; do contrário dois perfis da
    // mesma câmera ficam conectados simultaneamente sem necessidade.
    const sourceOnDemand = !(
      pathName.endsWith('_grid_hevc')
      && parsedForHot
      && this.isGridSourceHot(parsedForHot.cameraId)
    );
    const desired = {
      source: sourceUrl,
      sourceOnDemand,
      sourceOnDemandStartTimeout,
      sourceOnDemandCloseAfter,
      rtspTransport,
    };
    try {
      const current: any = await this.getPath(sourcePathName);
      if (
        current.source === desired.source
        && current.sourceOnDemand === desired.sourceOnDemand
        && current.rtspTransport === desired.rtspTransport
        && this.sameDuration(
          current.sourceOnDemandStartTimeout,
          desired.sourceOnDemandStartTimeout,
        )
        && this.sameDuration(
          current.sourceOnDemandCloseAfter,
          desired.sourceOnDemandCloseAfter,
        )
      ) {
        return sourcePathName;
      }
    } catch {
      // Ausente: criação abaixo.
    }
    await this.apiRequest(
      'DELETE',
      `/v3/config/paths/delete/${encoded}`,
    ).catch(() => undefined);
    await this.apiRequest('POST', `/v3/config/paths/add/${encoded}`, desired);
    return sourcePathName;
  }

  getPathNameForCamera(cameraId: string, deliveryMode: LiveViewMode = 'original') {
    return this.pathNameFromCameraId(cameraId, deliveryMode);
  }

  private buildEnsureKey(cameraId: string, deliveryMode: LiveViewMode) {
    return `${cameraId}:${deliveryMode}`;
  }

  invalidateMainCodecCache(cameraId: string) {
    for (const key of this.liveCodecCache.keys()) {
      if (key.startsWith(`${cameraId}:`)) this.liveCodecCache.delete(key);
    }
    for (const key of [...this.gridSourceCache.keys()]) {
      if (key.startsWith(`grid:${cameraId}:`)) this.gridSourceCache.delete(key);
    }
    for (const key of [...this.pathEnsureCache.keys()]) {
      if (key.startsWith(`${cameraId}:`)) this.pathEnsureCache.delete(key);
    }
    for (const key of [...this.pathEnsureInFlight.keys()]) {
      if (key.startsWith(`${cameraId}:`)) this.pathEnsureInFlight.delete(key);
    }
  }

  // Sonda o codec do stream via ffprobe (assíncrono, não bloqueia o event loop).
  // Retorna null se falhar (câmera offline/instável), para o chamador decidir o fallback.
  probeStreamVideoCodec(sourceUrl: string, transport: string): Promise<string | null> {
    return this.probeStreamVideoMetadata(sourceUrl, transport).then(value => value?.codec ?? null);
  }

  /**
   * Sonda com TETO GLOBAL de concorrência.
   *
   * A escada de descoberta do sub tem até 5 degraus SEQUENCIAIS por câmera. Numa
   * grade de 21 tiles com cache frio isso vira até 105 `ffprobe` simultâneos
   * contra o MESMO DVR — e o alvo é justamente o equipamento do cliente, com
   * uplink limitado e limite de sessões RTSP. A tempestade não só demora: ela
   * DERRUBA a fonte que estava tentando descobrir, e o resultado é a grade
   * inteira em 0 fps.
   *
   * O teto não muda decisão nenhuma — apenas serializa o excedente numa fila.
   * A descoberta continua idêntica (mesmos degraus, mesma preferência por
   * H.264); só deixa de ser um ataque de negação de serviço contra o DVR.
   */
  private probeStreamVideoMetadata(
    sourceUrl: string,
    transport: string,
  ): Promise<StreamMetadata | null> {
    // One bounded probe per physical URL/transport, shared across modalities.
    // Credential changes invalidate identity without storing credentials in keys.
    const key = createHash('sha256').update(JSON.stringify([sourceUrl, transport])).digest('hex');
    const cached = this.streamMetadataCache.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
    const pending = this.streamMetadataInFlight.get(key);
    if (pending) return pending;
    const task = this.withProbeSlot(() => this.runProbeStreamVideoMetadata(sourceUrl, transport))
      .then(value => {
        if (this.streamMetadataCache.size >= 512) {
          this.streamMetadataCache.delete(this.streamMetadataCache.keys().next().value!);
        }
        this.streamMetadataCache.set(key, { value, expires: Date.now() + (value ? 300_000 : 10_000) });
        return value;
      }).finally(() => this.streamMetadataInFlight.delete(key));
    this.streamMetadataInFlight.set(key, task);
    return task;
  }

  /** Enfileira quando o teto de sondas simultâneas já está ocupado. */
  private withProbeSlot<T>(task: () => Promise<T>): Promise<T> {
    const limit = this.maxConcurrentProbes;
    if (this.activeProbes < limit) {
      this.activeProbes += 1;
      return task().finally(() => this.releaseProbeSlot());
    }
    return new Promise<T>((resolve, reject) => {
      this.probeQueue.push(() => {
        this.activeProbes += 1;
        task().then(resolve, reject).finally(() => this.releaseProbeSlot());
      });
    });
  }

  private releaseProbeSlot() {
    this.activeProbes = Math.max(0, this.activeProbes - 1);
    const next = this.probeQueue.shift();
    if (next) next();
  }

  private runProbeStreamVideoMetadata(
    sourceUrl: string,
    transport: string,
  ): Promise<StreamMetadata | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: StreamMetadata | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const proc = spawnWithSecretUrl('ffprobe', [
          '-v', 'error',
          '-rtsp_transport', transport,
          '-timeout', '5000000',
          '-show_entries', 'stream=codec_name,codec_type,width,height',
          '-of', 'json',
          sourceUrl,
        ], sourceUrl);
        let stdout = '';
        proc.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          finish(null);
        }, 8000);
        killTimer.unref();
        proc.on('error', () => { clearTimeout(killTimer); finish(null); });
        proc.on('close', (code) => {
          clearTimeout(killTimer);
          if (code !== 0) return finish(null);
          try {
            const streams = JSON.parse(stdout)?.streams ?? [];
            const stream = streams.find((item: any) => item?.codec_type === 'video') ?? {};
            const audio = streams.find((item: any) => item?.codec_type === 'audio');
            finish({
              codec: String(stream.codec_name ?? '').trim().toLowerCase() || null,
              width: Number.isFinite(Number(stream.width)) ? Number(stream.width) : null,
              height: Number.isFinite(Number(stream.height)) ? Number(stream.height) : null,
              hasDataTrack: streams.some((item: any) => item?.codec_type === 'data'),
              audioCodec: audio
                ? String(audio.codec_name ?? '').trim().toLowerCase() || null
                : stream.codec_name ? 'none' : null,
            });
          } catch {
            finish(null);
          }
        });
      } catch {
        finish(null);
      }
    });
  }

  /**
   * Esta câmera aceita uma SEGUNDA sessão RTSP enquanto já está publicando?
   *
   * Guardado por câmera porque é característica do equipamento, não do momento.
   * A Mercusys do cliente recusa ("Operation not permitted"); a maioria aceita.
   * Sem essa distinção só há escolha ruim: reaproveitar sempre degradaria a
   * Máxima da frota inteira, e discar sempre mantém a tela preta nas de sessão
   * única.
   */
  private readonly aceitaSegundaSessaoPorCamera = new Map<string, { valor: boolean; em: number }>();
  private static readonly SEGUNDA_SESSAO_TTL_MS = 30 * 60_000;

  private async cameraAceitaSegundaSessao(cameraId: string, urlDaCamera: string, transport: string): Promise<boolean> {
    const guardado = this.aceitaSegundaSessaoPorCamera.get(cameraId);
    if (guardado && Date.now() - guardado.em < MediamtxProxyService.SEGUNDA_SESSAO_TTL_MS) {
      return guardado.valor;
    }
    // O probe JÁ É uma segunda sessão: se ele conecta, a câmera aceita. Falha
    // (null) cobre recusa e rede ruim — nos dois casos discar de novo é aposta
    // ruim, e o pior resultado possível é justamente a tela preta.
    const resultado = await this.probeStreamIsHevc(urlDaCamera, transport).catch(() => null);
    const valor = resultado !== null;
    this.aceitaSegundaSessaoPorCamera.set(cameraId, { valor, em: Date.now() });
    this.logger.log(`Câmera ${cameraId} ${valor ? 'aceita' : 'RECUSA'} uma segunda sessão RTSP simultânea.`);
    return valor;
  }

  private async probeStreamIsHevc(sourceUrl: string, transport: string): Promise<boolean | null> {
    const codec = await this.probeStreamVideoCodec(sourceUrl, transport);
    if (!codec) return null;
    return isHevcCodec(codec);
  }

  // Decide se o stream de Live é H.265 (precisa transcode). Usa cache curto para
  // não sondar a câmera a cada requisição de URLs. Em falha de probe, assume H.265
  // (transcode sempre entrega vídeo ao navegador; o pior caso é só custo de CPU).
  /**
   * Lê o que já descobrimos sobre a fonte leve desta câmera.
   *
   * Devolve `null` quando não há nada anotado, quando o cadastro mudou desde a
   * descoberta, ou quando o banco não responde — nos três casos o chamador
   * sonda, que é o comportamento de sempre. Esta camada só pode ACELERAR;
   * nunca pode ser o motivo de uma câmera não aparecer.
   */
  /**
   * O QUE JÁ SABEMOS DE CADA CÂMERA, para a tela do operador.
   *
   * Existe por causa de um caso real (27/08/2026): três câmeras desta frota não
   * têm stream secundário e entregam 1080p em HEVC direto no mosaico. Num
   * computador forte passa; num mais fraco os quadros ficam pretos e
   * reiniciando. Antes disso, o único jeito de descobrir era alguém reclamar.
   */
  async relatorioDeFontesDoMosaico(): Promise<{
    resumo: { conformes: number; desviadas: number; naoVerificadas: number };
    padrao: string;
    items: Array<{
      id: string; nome: string; situacao: string; resumo: string; desvios: string[];
      principal: { codec: string | null; altura: number | null };
      stream2: { existe: boolean | null; codec: string | null; altura: number | null };
      verificadoEm: Date | null;
    }>;
  }> {
    const vazio = { resumo: { conformes: 0, desviadas: 0, naoVerificadas: 0 }, padrao: PADRAO_EM_PALAVRAS, items: [] };
    if (!this.prisma) return vazio;
    const cams = await this.prisma.camera.findMany({
      where: { enabled: true },
      select: {
        id: true, name: true,
        detectedVideoCodec: true, streamHeight: true,
        gridHasSubStream: true, gridSourceCodec: true, gridSourceHeight: true, gridProbedAt: true,
      },
      orderBy: { name: 'asc' },
    });
    const diagnosticos = cams.map((c) => conferirPadrao({
      codecPrincipal: c.detectedVideoCodec,
      alturaPrincipal: c.streamHeight,
      temSub: c.gridHasSubStream,
      codecSub: c.gridSourceCodec,
      alturaSub: c.gridSourceHeight,
    }));
    return {
      resumo: resumirFrota(diagnosticos),
      padrao: PADRAO_EM_PALAVRAS,
      items: cams.map((c, i) => ({
        id: c.id,
        nome: c.name,
        situacao: diagnosticos[i].situacao,
        resumo: diagnosticos[i].resumo,
        desvios: diagnosticos[i].desvios,
        principal: { codec: c.detectedVideoCodec, altura: c.streamHeight },
        stream2: { existe: c.gridHasSubStream, codec: c.gridSourceCodec, altura: c.gridSourceHeight },
        verificadoEm: c.gridProbedAt,
      })),
    };
  }

  /**
   * "Procure de novo nesta câmera."
   *
   * A anotação não pode virar prisão: quem finalmente ligar o stream
   * secundário dentro da câmera precisa de um jeito de mandar o sistema
   * reaprender, sem esperar reinício nem mexer no cadastro à toa.
   */
  async reaprenderFonteDoMosaico(cameraId: string): Promise<void> {
    await this.esquecerAnotacaoDoMosaico(cameraId);
    for (const chave of [...this.gridSourceCache.keys()]) {
      if (chave.includes(cameraId)) this.gridSourceCache.delete(chave);
    }
  }

  private async lerAnotacaoDoMosaico(cameraId: string, impressao: string) {
    if (!this.prisma) return null;
    try {
      const c = await this.prisma.camera.findUnique({
        where: { id: cameraId },
        select: {
          gridHasSubStream: true, gridSourceUrl: true, gridSourceCodec: true,
          gridSourceWidth: true, gridSourceHeight: true,
          gridRequiresSanitization: true, gridProbeKey: true, gridProbedAt: true,
        },
      });
      if (!c) return null;
      const r = lerAnotacao(
        {
          chave: c.gridProbeKey,
          urlSemSegredo: c.gridSourceUrl,
          codec: c.gridSourceCodec,
          temSub: c.gridHasSubStream,
          precisaLimpeza: c.gridRequiresSanitization,
          descobertoEm: c.gridProbedAt,
        },
        impressao,
        Date.now(),
      );
      return r.usar ? { ...r, width: c.gridSourceWidth, height: c.gridSourceHeight } : null;
    } catch {
      return null;
    }
  }

  /**
   * Anota o que acabamos de descobrir.
   *
   * `url = null` significa "esta câmera NÃO tem stream secundário" — e isso é
   * tão valioso quanto o caminho positivo: é o que faz a sondagem inútil parar.
   *
   * A senha é retirada antes de gravar. Ela já vive no cadastro; guardar de
   * novo aqui só criaria um segundo lugar para vazar.
   */
  private async anotarMosaico(
    cameraId: string,
    impressao: string,
    url: string | null,
    codec: string | null,
    precisaLimpeza: boolean,
    largura: number | null = null,
    altura: number | null = null,
  ) {
    if (!this.prisma) return;
    try {
      await this.prisma.camera.update({
        where: { id: cameraId },
        data: {
          gridHasSubStream: Boolean(url),
          gridSourceUrl: semSegredo(url),
          gridSourceCodec: url ? codec : null,
          gridSourceWidth: url ? largura : null,
          gridSourceHeight: url ? altura : null,
          gridRequiresSanitization: precisaLimpeza,
          gridProbeKey: impressao,
          gridProbedAt: new Date(),
        },
      });
    } catch {
      // Anotar é conveniência. Falhar aqui só significa sondar de novo depois.
    }
  }

  /** Apaga a anotação — usado quando a fonte anotada se prova morta. */
  private async esquecerAnotacaoDoMosaico(cameraId: string) {
    if (!this.prisma) return;
    try {
      await this.prisma.camera.update({
        where: { id: cameraId },
        data: { gridHasSubStream: null, gridSourceUrl: null, gridSourceCodec: null,
                gridSourceWidth: null, gridSourceHeight: null,
                gridRequiresSanitization: null, gridProbeKey: null, gridProbedAt: null },
      });
    } catch { /* idem */ }
  }

  private async resolveLiveStreamIsHevc(cacheKey: string, sourceUrl: string, transport: string, codecConhecido?: string | null): Promise<boolean> {
    const cached = this.liveCodecCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MediamtxProxyService.LIVE_CODEC_TTL_MS) {
      return cached.isHevc;
    }
    const probed = await this.probeStreamIsHevc(sourceUrl, transport);
    if (probed === null) {
      // A SONDA FALHOU. Assumir HEVC aqui era o padrão, e custava caro: em
      // câmera de sessão única a sonda é uma SEGUNDA conexão e falha SEMPRE —
      // então uma fonte que já é H.264 era reencodada H.264→H.264 para sempre,
      // com ~5× de CPU e perda de qualidade, sem ganho nenhum. Reclamado em
      // 14/08/2026: "acho que em qualquer canal a camera está enviando H.264
      // ... 5x cpu sendo que já está em H.264 em qualquer stream ??????"
      //
      // Quando o cadastro já sabe o codec (detectado no cadastro, quando não
      // havia disputa de sessão), essa informação é melhor que um chute. Só
      // caímos no "presuma HEVC" quando NINGUÉM sabe — aí o pior caso volta a
      // ser custo de CPU, e nunca tela preta.
      if (codecConhecido) {
        const conhecidoEhHevc = isHevcCodec(codecConhecido);
        this.logger.log(
          `Sonda de codec falhou; usando o codec já conhecido da câmera (${codecConhecido}) `
          + `em vez de presumir HEVC. Transcode ${conhecidoEhHevc ? 'necessário' : 'DISPENSADO'}.`,
        );
        return conhecidoEhHevc;
      }
      return true;
    }
    this.liveCodecCache.set(cacheKey, { isHevc: probed, at: Date.now() });
    return probed;
  }

  private alternateMainPath(rtspPath: string | null | undefined, channel: number): string | null {
    const p = (rtspPath || '').toLowerCase();
    if (p.includes('realmonitor')) return `/Streaming/Channels/${channel}01`;
    if (p.includes('/streaming/channels')) return `/cam/realmonitor?channel=${channel}&subtype=0`;
    return null;
  }

  private streamPixels(stream: { width: number | null; height: number | null } | null | undefined) {
    const width = Number(stream?.width ?? 0);
    const height = Number(stream?.height ?? 0);
    return Number.isFinite(width) && Number.isFinite(height) ? width * height : 0;
  }

  private async chooseLiveSource(
    cameraId: string,
    camera: any,
    password: string,
    transport: string,
    original = false,
  ) {
    // A visualizacao comum usa o perfil live. "Maxima resolucao" precisa usar
    // o perfil principal/de gravacao, mesmo quando o administrador escolheu um
    // substream leve para a tela instantanea.
    const configuredProfile = original
      ? resolveOriginalRtspProfile(camera)
      : resolveLiveRtspProfile(camera);
    const sourceUrl = buildRtspUrl({
      username: camera.username,
      password,
      ip: camera.ip,
      rtspPort: camera.rtspPort,
      rtspPath: camera.rtspPath,
      channel: configuredProfile.channel,
      subtype: configuredProfile.subtype,
    });
    let chosenSourceUrl = sourceUrl;
    let chosenCodec: string | null = null;
    const detectedPixels = Number(camera.detectedWidth ?? 0) * Number(camera.detectedHeight ?? 0);
    const configuredPixels = Number(camera.streamWidth ?? 0) * Number(camera.streamHeight ?? 0);
    const shouldCheckAlternateMain =
      detectedPixels > 0 &&
      (detectedPixels < 1280 * 720 || (configuredPixels > 0 && detectedPixels < configuredPixels));
    const alternatePath = shouldCheckAlternateMain
      ? this.alternateMainPath(camera.rtspPath, configuredProfile.channel)
      : null;
    if (alternatePath) {
      // Terceiro cache com o mesmo defeito de `updatedAt` (ver chooseGridSource):
      // chave por configuração efetiva.
      const liveSourceCacheKey = [
        'live-source', cameraId, camera.ip, camera.rtspPort, camera.username,
        camera.rtspPath ?? '', configuredProfile.channel, configuredProfile.subtype,
      ].join('|');
      const cached = this.liveSourceCache.get(liveSourceCacheKey);
      if (cached && Date.now() - cached.at < MediamtxProxyService.LIVE_CODEC_TTL_MS) {
        chosenSourceUrl = cached.url;
        chosenCodec = cached.codec;
      } else {
        const alternateUrl =
          `rtsp://${encodeURIComponent(camera.username)}:${encodeURIComponent(password)}@` +
          `${camera.ip}:${camera.rtspPort}${alternatePath}`;
        const [primaryMetadata, alternateMetadata] = await Promise.all([
          this.probeStreamVideoMetadata(sourceUrl, transport),
          this.probeStreamVideoMetadata(alternateUrl, transport),
        ]);
        const primaryPixels = this.streamPixels(primaryMetadata);
        const alternatePixels = this.streamPixels(alternateMetadata);
        if (alternateMetadata && alternatePixels > primaryPixels) {
          chosenSourceUrl = alternateUrl;
          chosenCodec = alternateMetadata.codec;
          this.logger.log(
            `Live principal alternativo escolhido para ${cameraId}: ` +
            `${primaryMetadata?.width ?? '?'}x${primaryMetadata?.height ?? '?'} -> ` +
            `${alternateMetadata.width ?? '?'}x${alternateMetadata.height ?? '?'}`,
          );
        } else {
          chosenCodec = primaryMetadata?.codec ?? null;
        }
        this.liveSourceCache.set(liveSourceCacheKey, {
          url: chosenSourceUrl,
          codec: chosenCodec,
          width: (chosenSourceUrl === alternateUrl ? alternateMetadata : primaryMetadata)?.width ?? null,
          height: (chosenSourceUrl === alternateUrl ? alternateMetadata : primaryMetadata)?.height ?? null,
          at: Date.now(),
        });
      }
    }
    // Mesma correção da grade: configuração efetiva, NUNCA `updatedAt` (que o
    // health check reescreve a cada ciclo e transformava este cache em lixo,
    // forçando ffprobe de codec em toda abertura de câmera).
    const cacheKey = [
      cameraId,
      camera.ip,
      camera.rtspPort,
      camera.username,
      camera.rtspPath ?? '',
      configuredProfile.channel,
      configuredProfile.subtype,
    ].join('|');
    // Passthrough vs transcode. Confiamos no rótulo detectado SÓ quando ele diz
    // HEVC: a decisão vira "transcodar" e, se o rótulo estiver errado (fonte já é
    // H.264), o pior caso é custo de CPU — nunca tela preta. Quando o rótulo diz
    // H.264 (ou está vazio) a decisão seria PASSTHROUGH; aí errar = passar HEVC
    // cru pro WebRTC = TELA PRETA. E o codec da câmera muda na prática (operador
    // reconfigura, o rótulo fica velho). Por isso, antes de fazer passthrough,
    // confirmamos o codec real com um probe cacheado (barato, TTL curto).
    const detectedCodec = String(camera.detectedVideoCodec ?? '').trim().toLowerCase();
    const isHevc =
      chosenCodec
        ? isHevcCodec(chosenCodec)
        : detectedCodec && isHevcCodec(detectedCodec)
        ? true
        : await this.resolveLiveStreamIsHevc(cacheKey, chosenSourceUrl, transport,
            detectedCodec || String(camera.streamVideoCodec ?? '').trim().toLowerCase() || null);

    // A fonte Live e uma escolha operacional explicita. HEVC e convertido
    // para o navegador, mas nunca trocado silenciosamente por outro subtype.
    return {
      profile: configuredProfile,
      sourceUrl: chosenSourceUrl,
      isHevc,
      bitrateKbps: Number(camera.detectedBitrateKbps ?? camera.streamBitrateKbps) || null,
    };
  }

  /**
   * Escolhe a fonte para a GRADE (mosaico) com a "inteligência" de sub-stream:
   *  1) Tenta o SUB-stream (subtype 1). Se o ffprobe lê o codec:
   *       - H.264 → usa direto (o chamador faz PASSTHROUGH, sem transcodificar);
   *       - H.265 → usa o sub, mas o chamador transcodifica (do 480p, bem mais leve).
   *  2) Se a câmera NÃO tem sub-stream (probe falha) → cai para o MAIN (comportamento
   *     antigo: passthrough se H.264, transcode se H.265).
   * O resultado do probe é cacheado por câmera para não sondar a cada configuração.
   */
  // Caminho RTSP do SUB no protocolo ALTERNATIVO. Algumas câmeras OEM amarram cada
  // protocolo a um stream fixo: /Streaming/Channels/* sempre devolve o main e
  // /cam/realmonitor* sempre devolve o sub (H.264), ignorando o índice do canal.
  //
  // Atenção: as duas sintaxes também aparecem em fabricantes diferentes. Uma
  // Intelbras/Hikvision pode aceitar a conexão Dahua e até responder ao probe,
  // mas não sustentar uma sessão de vídeo utilizável. Por isso o protocolo
  // alternativo é contingência para caminho SEM vídeo, nunca uma otimização por
  // codec (H.265 válido não autoriza mudar de família de URL).
  private alternateSubPath(rtspPath: string | null | undefined, channel: number): string | null {
    const p = (rtspPath || '').toLowerCase();
    if (p.includes('/streaming/channels')) return `/cam/realmonitor?channel=${channel}&subtype=1`;
    if (p.includes('realmonitor')) return `/Streaming/Channels/${channel}02`;
    return null;
  }

  private async chooseGridSource(cameraId: string, camera: any, password: string, transport: string) {
    const subProfile = resolveGridRtspProfile(camera);
    // A CHAVE É A CONFIGURAÇÃO EFETIVA, NUNCA `updatedAt`.
    //
    // Com `updatedAt` na chave, o cache era LIXO: o health check reescreve a
    // linha da câmera a cada ciclo (rotação de ~10s por câmera nesta frota),
    // então TODA abertura de tile invalidava a decisão e pagava a escada de
    // ffprobes de novo — até 5 sondas de 8s em sequência. Era a causa direta
    // do "primeiro acesso demora 30s" que sobreviveu a todas as outras
    // correções: o cache de 30 minutos nunca chegava a 10 segundos de vida.
    //
    // O que DEVE invalidar a decisão é o que muda a URL: endereço, porta,
    // credencial, caminho e canal. Mudou algum → chave nova → re-sonda. Health
    // check tocando `lastSeenAt`/`status` não muda nada disso.
    const cacheKey = [
      // Versão da decisão: v3 deixou de promover uma URL que aceita RTSP mas
      // não entrega parâmetros de vídeo decodificáveis. Mantê-la na chave faz
      // cada câmera revalidar
      // sua anotação uma única vez após o deploy, sem uma limpeza global nem
      // novas sondas a cada abertura.
      'grid-v3',
      cameraId,
      camera.ip,
      camera.rtspPort,
      camera.username,
      camera.rtspPath ?? '',
      subProfile.channel,
      subProfile.subtype,
    ].join('|');

    // Cache: devolve a decisão pronta (url do sub OU null = usar o main).
    //
    // COM AUTOCURA: uma decisão cacheada pode estar MORTA na prática — visto em
    // produção com câmeras OEM (Cam-03/09): o endpoint "alternativo" responde ao
    // ffprobe na hora da escolha, mas na sessão contínua do MediaMTX aceita o
    // RTSP e nunca envia mídia (path ready sem NENHUMA faixa). Sem esta
    // verificação, o tile fica em 0 fps até o TTL do cache expirar, e o
    // operador lê como "a grade travou". Se o path da grade está comprovadamente
    // sem mídia, a decisão é descartada e re-sondada AGORA (com cooldown por
    // câmera para não virar tempestade de probe contra câmera doente).
    let cached = this.gridSourceCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MediamtxProxyService.LIVE_CODEC_TTL_MS) {
      const healCooldownMs = 60_000;
      const lastHeal = this.gridHealAt.get(cameraId) ?? 0;
      if (Date.now() - lastHeal > healCooldownMs && await this.gridPathLooksDead(cameraId)) {
        this.gridHealAt.set(cameraId, Date.now());
        this.gridSourceCache.delete(cacheKey);
        cached = undefined;
        // A anotação do banco descreve a MESMA fonte morta: mantê-la faria o
        // próximo reinício reaproveitar exatamente o caminho que não entrega.
        void this.esquecerAnotacaoDoMosaico(cameraId);
        this.logger.warn(
          `Grade de ${cameraId}: fonte cacheada sem mídia (sessão aceita, nenhuma faixa) — descartando decisão e re-sondando.`,
        );
      }
    }
    if (cached && Date.now() - cached.at < MediamtxProxyService.LIVE_CODEC_TTL_MS) {
      if (cached.url) {
        return {
          profile: subProfile,
          sourceUrl: cached.url,
          isHevc: cached.codec ? isHevcCodec(cached.codec) : false,
          width: cached.width,
          height: cached.height,
          usedSubStream: true,
          requiresSanitization: cached.requiresSanitization,
        };
      }
      const m = await this.chooseLiveSource(cameraId, camera, password, transport);
      return {
        profile: m.profile,
        sourceUrl: m.sourceUrl,
        isHevc: m.isHevc,
        usedSubStream: false,
        requiresSanitization: false,
      };
    }

    // MEMÓRIA DE LONGO PRAZO: o que já descobrimos, guardado no banco.
    //
    // O cache acima morre com o processo; este não. Sem ele, reiniciar a API
    // fazia TODA a frota ser sondada de novo — e câmera sem stream secundário
    // (Cam-24/25/26 desta frota) era interrogada para sempre, sempre recebendo
    // a mesma resposta negativa. Ver helpers/memoria-do-mosaico.helper.ts.
    //
    // É só uma segunda camada de cache: a decisão em si continua sendo tomada
    // exatamente pelo mesmo código de sempre. Falhou a leitura, ou o cadastro
    // mudou? Cai na sondagem de sempre.
    const impressao = `grid-v3|${impressaoDoCadastro({
      ip: camera.ip, rtspPort: camera.rtspPort, username: camera.username,
      rtspPath: camera.rtspPath, channel: subProfile.channel, subtype: subProfile.subtype,
    })}`;
    const anotado = await this.lerAnotacaoDoMosaico(cameraId, impressao);
    if (anotado) {
      if (anotado.urlSemSegredo) {
        const url = comSegredo(anotado.urlSemSegredo, camera.username, password);
        if (url) {
          this.gridSourceCache.set(cacheKey, {
            url, codec: anotado.codec, width: anotado.width, height: anotado.height,
            requiresSanitization: anotado.precisaLimpeza, at: Date.now(),
          });
          return {
            profile: subProfile,
            sourceUrl: url,
            isHevc: anotado.codec ? isHevcCodec(anotado.codec) : false,
            width: anotado.width,
            height: anotado.height,
            usedSubStream: true,
            requiresSanitization: anotado.precisaLimpeza,
          };
        }
      } else {
        // Anotado como "não tem sub". É o caso que mais economiza: sem isto,
        // três câmeras desta frota seriam sondadas em vão a cada abertura.
        this.gridSourceCache.set(cacheKey, {
          url: null, codec: null, width: null, height: null, requiresSanitization: false, at: Date.now(),
        });
        const m = await this.chooseLiveSource(cameraId, camera, password, transport);
        return {
          profile: m.profile, sourceUrl: m.sourceUrl, isHevc: m.isHevc,
          usedSubStream: false, requiresSanitization: false,
        };
      }
    }

    // Candidato 1: sub no caminho configurado (subtype 1 aplicado ao rtspPath).
    const primaryUrl = buildRtspUrl({
      username: camera.username, password, ip: camera.ip, rtspPort: camera.rtspPort,
      rtspPath: camera.rtspPath, channel: subProfile.channel, subtype: subProfile.subtype,
    });
    // Candidato 2: sub no protocolo alternativo (para as OEM Hik↔Dahua).
    const altPath = this.alternateSubPath(camera.rtspPath, subProfile.channel);
    const altUrl = altPath
      ? `rtsp://${encodeURIComponent(camera.username)}:${encodeURIComponent(password)}@${camera.ip}:${camera.rtspPort}${altPath}`
      : null;

    const found: Array<{
      url: string;
      codec: string;
      width: number | null;
      height: number | null;
      hasDataTrack: boolean;
    }> = [];
    // Um "H.264" sem largura/altura não é um substream utilizável: o RTSP
    // respondeu ao probe, porém ainda não entregou SPS/PPS nem primeiro quadro.
    // Promovê-lo por ser H.264 deixava MediaMTX/WebRTC conectados, mas pretos.
    // Preferimos o stream HEVC íntegro e o transcodificamos para a grade a
    // guardar uma falsa economia de CPU que não mostra imagem.
    const addUsableCandidate = (
      url: string,
      metadata: { codec: string | null; width: number | null; height: number | null; hasDataTrack: boolean } | null,
    ) => {
      if (!metadata?.codec || this.streamPixels(metadata) <= 0) return false;
      found.push({
        url,
        codec: metadata.codec,
        width: metadata.width,
        height: metadata.height,
        hasDataTrack: metadata.hasDataTrack,
      });
      return true;
    };
    const c1 = await this.probeStreamVideoMetadata(primaryUrl, transport);
    addUsableCandidate(primaryUrl, c1);
    // Só sonda o protocolo alternativo quando o caminho configurado NÃO trouxe
    // vídeo. Não usamos mais "não é H.264" como gatilho: isso fez uma câmera
    // Intelbras/Hikvision com sub H.265 ser trocada silenciosamente por uma URL
    // Dahua, que respondia ao ffprobe mas deixava WebRTC/HLS sem primeiro frame.
    // H.265 válido continua sendo uma fonte real e o pipeline de grade o
    // converte para H.264 quando o navegador precisar.
    const has264 = () => found.some((f) => !isHevcCodec(f.codec));
    if (found.length === 0 && altUrl) {
      const c2 = await this.probeStreamVideoMetadata(altUrl, transport);
      addUsableCandidate(altUrl, c2);
    }

    // O endpoint se chama "sub", mas devolve o MAIN: medido na Cam-01, tanto
    // N02 quanto o protocolo alternativo entregavam HEVC 1920x1080. Tratar isso
    // como substream criava o pior pipeline da frota (decode 1080p + scale +
    // x264), 20,6% de um núcleo. Nessa anomalia específica vale UM probe extra
    // em /media/video2, endpoint declarado por vários OEM via ONVIF. Não liga a
    // busca profunda global nem atrasa câmeras cujo substream já é realmente leve.
    const smallestCandidatePixels = found.reduce(
      (smallest, candidate) => Math.min(smallest, this.streamPixels(candidate) || Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );
    if (!has264()
      && !this.deepSubSearchEnabled
      && smallestCandidatePixels >= 1280 * 720) {
      const lightweightOemUrl =
        `rtsp://${encodeURIComponent(camera.username)}:${encodeURIComponent(password)}@` +
        `${camera.ip}:${camera.rtspPort}/media/video${subProfile.channel + 1}`;
      const lightweightOem = await this.probeStreamVideoMetadata(lightweightOemUrl, transport);
      if (lightweightOem && addUsableCandidate(lightweightOemUrl, lightweightOem)) {
        this.logger.log(
          `Grade de ${cameraId}: endpoint substream devolvia resolução principal; ` +
          `/media/video${subProfile.channel + 1} respondeu ` +
          `${lightweightOem.width ?? '?'}x${lightweightOem.height ?? '?'} ${lightweightOem.codec}.`,
        );
      }
    }
    // TERCEIRO degrau: o SUB 2. Muitas câmeras têm TRÊS streams, e o operador
    // que configura "o segundo stream em H.264 para o live" pode tê-lo no
    // índice 2 (Dahua subtype=2, Hikvision canal N03) — enquanto o sub 1
    // continua H.265 de fábrica. A busca parava no sub 1 e condenava a câmera
    // a transcode para sempre, com o stream H.264 configurado à mão parado do
    // lado. Escada mantida: cada degrau só é sondado se o anterior não achou
    // H.264, então câmera bem comportada continua custando UM probe.
    // ESTE BLOCO NÃO RODA NA ABERTURA DO TILE POR PADRÃO.
    //
    // MEDIDO nesta frota (30/07): as 16 grades configuradas usam TODAS o degrau
    // 1 (`subtype=1`). Nenhuma usa /media/videoN, subtype=2 ou N03 — os degraus
    // profundos não encontraram nada aqui. E o custo cai justamente nas piores
    // câmeras: quem tem sub H.265 não acha H.264 em degrau nenhum, então
    // percorre os 4 restantes (até 32s de sonda) para no fim usar o H.265
    // mesmo. As 10 câmeras que já precisam de transcode pagavam a busca inteira.
    //
    // A busca profunda NÃO é errada — uma investigação por ONVIF provou que há
    // OEM que declara o stream real em /media/videoN. O erro é ONDE ela roda:
    // procurar 5 endpoints no instante em que o operador abre um tile é caro, e
    // o resultado não muda depois da primeira vez. Lugar dela é o cadastro/
    // diagnóstico da câmera, que roda uma vez e persiste.
    // MEDIAMTX_DEEP_SUB_SEARCH=true religa na live para instalação com OEM teimosa.
    if (!has264() && this.deepSubSearchEnabled) {
      const sub2Candidates = [
        // COMPROVADO NESTA FROTA via ONVIF GetProfiles: câmeras OEM que servem
        // /Streaming/Channels/101 declaram os streams REAIS em /media/videoN
        // (perfil 2 = /media/video2, 640x360 — o "stream 2 em H.264 para o
        // live" que o operador configurou à mão). A busca antiga nunca sondava
        // este endpoint e condenava a família inteira a transcode, com o
        // stream certo do lado. Os caminhos subtype=2/N03 cobrem Dahua e
        // Hikvision de 3 streams.
        `/media/video${subProfile.channel + 1}`,
        `/cam/realmonitor?channel=${subProfile.channel}&subtype=2`,
        `/Streaming/Channels/${subProfile.channel}03`,
      ];
      for (const path of sub2Candidates) {
        if (has264()) break;
        const url = `rtsp://${encodeURIComponent(camera.username)}:${encodeURIComponent(password)}@${camera.ip}:${camera.rtspPort}${path}`;
        const c3 = await this.probeStreamVideoMetadata(url, transport);
        addUsableCandidate(url, c3);
      }
    }

    // Preferência: qualquer sub H.264 (passthrough) > sub H.265 de menor resolução
    // (transcode mais leve). Algumas OEMs devolvem 1080p em /Streaming/Channels/102
    // e 360p em /cam/realmonitor?subtype=1; para grade, o menor H.265 é o correto.
    const bySmallestResolution = (a: { width: number | null; height: number | null }, b: { width: number | null; height: number | null }) => {
      const ap = this.streamPixels(a) || Number.MAX_SAFE_INTEGER;
      const bp = this.streamPixels(b) || Number.MAX_SAFE_INTEGER;
      return ap - bp;
    };
    const chosen =
      found.filter((f) => !isHevcCodec(f.codec)).sort(bySmallestResolution)[0] ??
      found.filter((f) => isHevcCodec(f.codec)).sort(bySmallestResolution)[0] ??
      found[0];
    if (chosen) {
      // Alguns endpoints Hikvision/OEM expõem uma faixa de metadados sem
      // descrição RTP válida junto ao vídeo. O MediaMTX registra continuamente
      // "unknown payload type" ao receber essa faixa. Nesses casos isolados,
      // um remux FFmpeg com -map apenas de vídeo remove a faixa sem recodificar.
      // A faixa de metadados NÃO é exclusiva do endpoint /Streaming/Channels/.
      // Medido nesta frota: o MediaMTX reporta faixa `Generic` em 15 das 19
      // câmeras, incluindo caminhos /media/videoN e /cam/realmonitor — e cada
      // uma delas registra "unknown payload type" continuamente (a Cam-01
      // sozinha despejava 30 avisos por MINUTO). Além do log inflado, esse
      // ruído afoga erro de verdade quando se investiga um incidente.
      // O sinal confiável é a faixa detectada, não o formato da URL: quem tem
      // faixa de dados precisa do remux que a descarta, venha ela de onde vier.
      const requiresSanitization = chosen.hasDataTrack || this.gridHasGenericTrack.has(cameraId);
      this.gridSourceCache.set(cacheKey, {
        url: chosen.url,
        codec: chosen.codec,
        width: chosen.width,
        height: chosen.height,
        requiresSanitization,
        at: Date.now(),
      });
      void this.anotarMosaico(cameraId, impressao, chosen.url, chosen.codec, requiresSanitization,
        chosen.width, chosen.height);
      return {
        profile: subProfile,
        sourceUrl: chosen.url,
        isHevc: isHevcCodec(chosen.codec),
        width: chosen.width,
        height: chosen.height,
        usedSubStream: true,
        requiresSanitization,
      };
    }

    // Sem sub utilizável → usa a fonte principal (mesma do live).
    this.gridSourceCache.set(cacheKey, {
      url: null,
      codec: null,
      width: null,
      height: null,
      requiresSanitization: false,
      at: Date.now(),
    });
    // Anotar a AUSÊNCIA de sub é o que impede a sondagem eterna.
    void this.anotarMosaico(cameraId, impressao, null, null, false);
    const main = await this.chooseLiveSource(cameraId, camera, password, transport);
    this.logger.log(`Grade sem sub-stream para ${cameraId}; usando o stream principal.`);
    return {
      profile: main.profile,
      sourceUrl: main.sourceUrl,
      isHevc: main.isHevc,
      usedSubStream: false,
      requiresSanitization: false,
    };
  }

  /**
   * Resolve a melhor fonte para uma captura estática usando exatamente a mesma
   * regra da grade: sub-stream H.264 menor primeiro, sub-stream H.265 depois e
   * stream principal apenas como fallback.
   *
   * Retorna a URL RTSP da câmera diretamente. Não cria nem lê um path MediaMTX:
   * conectar ao path `selected` para extrair um único frame iniciava um encode
   * de 6 Mbps que permanecia ativo por 90s e saturava a CPU ao carregar os
   * posters de várias câmeras.
   */
  async resolveGridPosterSource(cameraId: string) {
    const camera = await this.camerasService.getCameraOrThrow(cameraId);
    if ((camera as { enabled?: boolean }).enabled === false) {
      throw new BadRequestException('Câmera desativada.');
    }
    const transport =
      camera.preferredRtspTransport
      ?? this.configService.get<string>('ffmpegRtspTransport')
      ?? 'tcp';

    // RTMP não tem uma câmera para consultar por IP/RTSP: os campos de rede são
    // só marcadores do cadastro. O poster precisa capturar a publicação que já
    // chegou ao MediaMTX; tentar a seleção normal de grade aqui fazia o validador
    // de rede rejeitar 0.0.0.0 e mostrava "sem vídeo" apesar da live estar ativa.
    if (isPushSourced(camera)) {
      const selected = await this.resolvePushLiveSource(camera, transport);
      return {
        sourceUrl: selected.sourceUrl,
        profile: selected.profile,
        sourceVideoCodec: selected.isHevc ? 'h265' : 'h264',
        usedSubStream: false,
      };
    }

    const password = this.cryptoService.decrypt(camera.passwordEncrypted);
    const selected = await this.chooseGridSource(cameraId, camera, password, transport);
    return {
      sourceUrl: selected.sourceUrl,
      profile: selected.profile,
      sourceVideoCodec: selected.isHevc ? 'h265' : 'h264',
      usedSubStream: selected.usedSubStream,
    };
  }

  private durationToMilliseconds(value: string | undefined | null) {
    if (!value) return null;
    const matches = [...value.trim().matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
    if (!matches.length) return null;

    return matches.reduce((total, match) => {
      const amount = Number(match[1]);
      const unit = match[2];
      if (!Number.isFinite(amount)) return total;
      if (unit === 'ms') return total + amount;
      if (unit === 's') return total + amount * 1000;
      if (unit === 'm') return total + amount * 60 * 1000;
      if (unit === 'h') return total + amount * 60 * 60 * 1000;
      return total;
    }, 0);
  }

  private sameDuration(current: string | undefined, desired: string | undefined) {
    if (current === desired) return true;
    const currentMs = this.durationToMilliseconds(current);
    const desiredMs = this.durationToMilliseconds(desired);
    if (currentMs === null || desiredMs === null) return false;
    return currentMs === desiredMs;
  }

  private async apiRequest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
    const base = this.configService.get<string>('mediaMtxApiBaseUrl') ?? 'http://mediamtx:9997';
    const apiUser = (this.configService.get<string>('mediaMtxApiUser') ?? '').trim();
    const apiPass = (this.configService.get<string>('mediaMtxApiPass') ?? '').trim();
    if (!apiUser || !apiPass) {
      throw new Error('Credenciais da API do MediaMTX não configuradas (MEDIAMTX_API_USER/MEDIAMTX_API_PASS).');
    }
    const basicAuth = Buffer.from(`${apiUser}:${apiPass}`).toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${basicAuth}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // A config que enviamos ao MediaMTX embute a URL RTSP da câmera COM credencial;
        // um erro pode ecoá-la de volta no corpo. Sanitiza antes de virar Error.message
        // (que sobe para logs e mensagens de diagnóstico).
        const error: any = new Error(
          `MediaMTX API ${method} ${path} failed (${response.status}): ${sanitizeSensitiveText(text).slice(0, 160)}`,
        );
        // O código HTTP precisa sobreviver ao Error: quem reconcilia path tem de
        // distinguir "não existe" (404, recriar) de "não deu para ler agora"
        // (timeout/5xx) — tratar os dois igual APAGA path saudável com espectador.
        error.status = response.status;
        throw error;
      }
      return await response.text().catch(() => '');
    } finally {
      clearTimeout(timeout);
    }
  }

  // VAZÃO AO VIVO — o MediaMTX conta bytes ACUMULADOS por path (entrada, o que a
  // câmera empurra) e por sessão (saída, o que vai ao espectador). Taxa em Mbps =
  // (bytes agora − bytes da amostra anterior) / tempo. Guardamos a última amostra
  // aqui; o painel chama de poucos em poucos segundos e a diferença vira a taxa.
  // Suavizamos (EMA) para o número não pular feio entre leituras.
  private tpSample: { rx: number; tx: number; ts: number } | null = null;
  private tpRate = { inMbps: 0, outMbps: 0 };
  private tpHasRate = false;

  async getLiveThroughput(): Promise<{
    inMbps: number; outMbps: number; viewers: number;
    activeStreams: number; totalStreams: number; sampledAt: number;
  }> {
    const vazio = { inMbps: this.tpRate.inMbps, outMbps: this.tpRate.outMbps, viewers: 0, activeStreams: 0, totalStreams: 0, sampledAt: Date.now() };
    if (!this.isEnabled()) return { ...vazio, inMbps: 0, outMbps: 0 };
    try {
      const [pathsTxt, wrtcTxt, hlsTxt, rtspTxt] = await Promise.all([
        this.apiRequest('GET', '/v3/paths/list?itemsPerPage=1000'),
        this.apiRequest('GET', '/v3/webrtcsessions/list?itemsPerPage=1000').catch(() => '{"items":[]}'),
        this.apiRequest('GET', '/v3/hlsmuxers/list?itemsPerPage=1000').catch(() => '{"items":[]}'),
        this.apiRequest('GET', '/v3/rtspconns/list?itemsPerPage=1000').catch(() => '{"items":[]}'),
      ]);
      const paths = (JSON.parse(pathsTxt)?.items ?? []) as Array<Record<string, any>>;
      let rx = 0, viewers = 0, active = 0;
      for (const p of paths) {
        rx += Number(p?.bytesReceived ?? 0);
        viewers += Array.isArray(p?.readers) ? p.readers.length : 0;
        if (p?.ready) active++;
      }
      let tx = 0;
      for (const txt of [wrtcTxt, hlsTxt, rtspTxt]) {
        const items = (JSON.parse(txt)?.items ?? []) as Array<Record<string, any>>;
        for (const s of items) tx += Number(s?.bytesSent ?? 0);
      }
      const now = Date.now();
      const prev = this.tpSample;
      if (prev) {
        const dt = (now - prev.ts) / 1000;
        if (dt >= 0.4) {
          const inb = (Math.max(0, rx - prev.rx) * 8) / dt / 1e6;
          const outb = (Math.max(0, tx - prev.tx) * 8) / dt / 1e6;
          if (!this.tpHasRate) {
            this.tpRate = { inMbps: inb, outMbps: outb };
            this.tpHasRate = true;
          } else {
            const k = 0.5;
            this.tpRate = {
              inMbps: this.tpRate.inMbps * (1 - k) + inb * k,
              outMbps: this.tpRate.outMbps * (1 - k) + outb * k,
            };
          }
          this.tpSample = { rx, tx, ts: now };
        }
      } else {
        this.tpSample = { rx, tx, ts: now };
      }
      return {
        inMbps: Math.round(this.tpRate.inMbps * 100) / 100,
        outMbps: Math.round(this.tpRate.outMbps * 100) / 100,
        viewers, activeStreams: active, totalStreams: paths.length, sampledAt: now,
      };
    } catch {
      return vazio;
    }
  }

  private async getPath(pathName: string) {
    const encodedPath = encodeURIComponent(pathName);
    const text = await this.apiRequest('GET', `/v3/config/paths/get/${encodedPath}`);
    return JSON.parse(text) as {
      source?: string;
      sourceOnDemand?: boolean;
      sourceOnDemandStartTimeout?: string;
      sourceOnDemandCloseAfter?: string;
      rtspTransport?: string;
    };
  }

  /**
   * O path da GRADE está comprovadamente sem mídia?
   *
   * Só responde `true` nos dois estados que NUNCA são um cold start saudável:
   *  · fonte conectada (`ready`) e SEM nenhuma faixa — a câmera aceitou o RTSP
   *    e não descreveu mídia (OEM que amarra protocolo a stream faz isso);
   *  · há leitor esperando, a fonte não ficou pronta e nada foi recebido — a
   *    demanda existe há tempo suficiente para ter chegado ao menos 1 byte.
   * Path inexistente (404) é on-demand frio: saudável, não mexe. Qualquer erro
   * de consulta também devolve `false` — autocura nunca pode DERRUBAR uma
   * decisão válida por falha de leitura do estado.
   */
  /**
   * A frota inteira está muda? Então o problema NÃO é o endpoint de uma câmera.
   *
   * Distingue "escolhi o caminho errado nesta câmera" de "o link até o site
   * caiu". Só o primeiro se resolve re-sondando; no segundo, sondar é jogar
   * mais carga contra um DVR que já não responde. Uma única leitura da lista de
   * paths responde a pergunta — sem custo de rede contra as câmeras.
   */
  private async fleetLooksOffline(exceptCameraId: string): Promise<boolean> {
    try {
      const text = await this.apiRequest('GET', '/v3/paths/list?itemsPerPage=1000');
      const items = (JSON.parse(text) as { items?: Array<Record<string, any>> }).items ?? [];
      const exceptHash = exceptCameraId.replace(/[^a-zA-Z0-9]/g, '');
      let others = 0;
      let mute = 0;
      for (const item of items) {
        const name = String(item?.name ?? '');
        if (!name.startsWith('cam_') || name.includes(exceptHash)) continue;
        others += 1;
        if (item?.ready !== true && Number(item?.bytesReceived ?? 0) === 0) mute += 1;
      }
      // Poucos vizinhos para comparar: não há amostra que sustente a conclusão,
      // então mantém o comportamento antigo (autocura ativa) em vez de inventar.
      if (others < 3) return false;
      return mute / others >= 0.6;
    } catch {
      return false;
    }
  }

  private async gridPathLooksDead(cameraId: string): Promise<boolean> {
    if (!this.gridAutoHealEnabled) return false;
    if (!this.isEnabled()) return false;
    try {
      const pathName = this.pathNameFromCameraId(cameraId, 'grid');
      const text = await this.apiRequest('GET', `/v3/paths/get/${encodeURIComponent(pathName)}`);
      const data = JSON.parse(text) as Record<string, any>;
      const tracks = Array.isArray(data.tracks) ? data.tracks : [];
      const readers = Array.isArray(data.readers) ? data.readers : [];
      const bytes = Number(data.bytesReceived ?? 0);
      // Sessão aceita, nenhuma faixa: o endpoint ESCOLHIDO está errado. Re-sondar
      // resolve — é o caso que justificou a autocura.
      if (data.ready === true && tracks.length === 0) return true;
      // "Não pronto, com espectador, zero byte" descreve DUAS situações opostas:
      // o endpoint desta câmera está errado (re-sondar ajuda) OU a rede até o
      // site caiu (re-sondar SÓ PIORA). Sem separar as duas, a queda de link
      // virava realimentação: rede oscila → path sem mídia → cache descartado →
      // até 5 sondas × N câmeras contra o DVR que já está sufocado → path segue
      // morto → repete a cada 60s. Foi assim que uma instabilidade de rede
      // virou colapso total da frota, enquanto a versão antiga (sem autocura)
      // degradava suavemente.
      // Critério: se VÁRIAS câmeras estão mudas ao mesmo tempo, o problema é
      // comum a elas (link/roteador/DVR), não a escolha de endpoint de uma.
      if (data.ready !== true && readers.length > 0 && bytes === 0) {
        return !(await this.fleetLooksOffline(cameraId));
      }
      return false;
    } catch {
      return false;
    }
  }

  async getPathRuntimeSummaryForCamera(cameraId: string) {
    const pathName = this.pathNameFromCameraId(cameraId);
    const candidateNames = new Set<LiveViewMode>(['grid', 'grid-audio', 'grid-hevc', 'original', 'original-audio']);
    const expectedPaths = new Set([...candidateNames].map((mode) => this.pathNameFromCameraId(cameraId, mode)));
    if (!this.isEnabled()) {
      return {
        pathName,
        available: false,
        ready: false,
        readerCount: 0,
        readers: [] as Array<{ id: string | null; protocol: string | null; remoteAddr: string | null }>,
        bytesReceived: null as number | null,
        bytesSent: null as number | null,
        error: 'MediaMTX desabilitado.',
      };
    }

    try {
      const allItems = await this.getRuntimePathItems();
      const paths = allItems.filter((item: any) => expectedPaths.has(String(item?.name ?? '')));
      const rawReaders = paths.flatMap((data: any) => Array.isArray(data.readers)
        ? data.readers
        : data.readers && typeof data.readers === 'object'
          ? Object.values(data.readers)
          : []);

      const readers = rawReaders.map((reader: any) => ({
        id: typeof reader?.id === 'string' ? reader.id : null,
        protocol: typeof reader?.type === 'string'
          ? reader.type
          : typeof reader?.protocol === 'string'
            ? reader.protocol
            : null,
        remoteAddr: typeof reader?.remoteAddr === 'string'
          ? reader.remoteAddr.replace(/:\d+$/, ':*')
          : null,
      }));

      return {
        pathName,
        pathNames: paths.map((item: any) => String(item.name)),
        trackHealth: paths.map((item: any) => {
          const sample = this.trackHealthState.get(String(item.name));
          return { pathName: String(item.name), sampledAt: sample?.at ?? null,
            video: sample?.health.video ?? 'unknown', audio: sample?.health.audio ?? 'unknown' };
        }),
        available: paths.length > 0,
        ready: paths.some((data: any) => Boolean(data.ready ?? data.sourceReady ?? data.source?.ready)),
        readerCount: readers.length,
        readers,
        bytesReceived: paths.length
          ? paths.reduce((sum: number, data: any) => sum + (Number(data.bytesReceived) || 0), 0)
          : null,
        bytesSent: paths.length
          ? paths.reduce((sum: number, data: any) => sum + (Number(data.bytesSent) || 0), 0)
          : null,
        error: null as string | null,
      };
    } catch (error) {
      return {
        pathName,
        available: false,
        ready: false,
        readerCount: 0,
        readers: [] as Array<{ id: string | null; protocol: string | null; remoteAddr: string | null }>,
        bytesReceived: null as number | null,
        bytesSent: null as number | null,
        error: error instanceof Error ? error.message : 'Falha ao consultar runtime do MediaMTX.',
      };
    }
  }

  private async getRuntimePathItems(): Promise<any[]> {
    const cached = this.runtimePathListCache;
    if (cached && Date.now() - cached.at < 2000) return cached.items;
    if (this.runtimePathListInFlight) return this.runtimePathListInFlight;
    this.runtimePathListInFlight = this.apiRequest('GET', '/v3/paths/list?itemsPerPage=1000')
      .then((text) => {
        const parsed = JSON.parse(text);
        const items = Array.isArray(parsed?.items) ? parsed.items : [];
        this.runtimePathListCache = { at: Date.now(), items };
        return items;
      })
      .finally(() => {
        this.runtimePathListInFlight = null;
      });
    return this.runtimePathListInFlight;
  }

  private async warmCameraPaths() {
    try {
      // Aquece SÓ o conjunto quente (relevância + orçamento), não a frota.
      // Warm-up da frota inteira em 2.000 câmeras seria 2.000 probes e 2.000
      // sessões RTSP na largada do boot — contra os DVRs dos clientes.
      const todas = (await this.camerasService.findAllInternal())
        .filter((camera) => (camera as { enabled?: boolean }).enabled !== false);
      // AQUECER != PRÉ-CONECTAR. São duas coisas que estavam amarradas por engano.
      //
      // "Aquecer" é garantir que a CONFIGURAÇÃO do path no MediaMTX corresponde
      // ao que o código quer — inclusive correções novas, como a limpeza de
      // ffmpeg órfão. Path sob demanda não abre conexão nenhuma com a câmera ao
      // ser configurado; ele só disca quando alguém assiste.
      //
      // Amarrar isso ao conjunto quente criou um efeito colateral silencioso:
      // ao zerar o orçamento (nada pré-conectado, comportamento de 21/07), o
      // aquecimento passou a sair sem fazer NADA — e 11 de 12 paths ficaram
      // presos numa configuração antiga, sem receber a correção. Uma decisão de
      // economia de banda acabou congelando o deploy de código.
      //
      // Agora configura todos os habilitados; quem fica QUENTE segue decidido
      // pelo orçamento, lá em ensurePrivateSourcePath/reconcileHotGridSources.
      const cameras = todas;
      if (!cameras.length) return;

      this.logger.log(`Aquecendo paths MediaMTX de grade para ${cameras.length} câmera(s)...`);
      let nextIndex = 0;
      let warmed = 0;
      let failed = 0;
      const workerCount = Math.min(4, cameras.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < cameras.length) {
          const camera = cameras[nextIndex++];
          try {
            // A grade usa a entrega H.264 compatível. Aquecer a fonte HEVC em
            // paralelo abria uma segunda sessão RTSP por câmera e deixava o
            // DVR disputando banda com um caminho que a interface não usa.
            await this.ensurePathForCamera(camera.id, 'grid');
            warmed += 1;
          } catch {
            failed += 1;
          }
        }
      }));
      if (failed > 0) {
        this.logger.warn(`Aquecimento MediaMTX parcial: ${warmed}/${cameras.length} path(s) prontos.`);
      } else {
        this.logger.log(`Aquecimento MediaMTX concluído: ${warmed}/${cameras.length} path(s) prontos.`);
      }
      // O reconciliador mantém fontes frias sem segurar sessões RTSP.
      await this.reconcileHotGridSources();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido';
      this.logger.warn(`Falha ao aquecer paths MediaMTX: ${message}`);
    }
  }

  /** Remove os paths de uma câmera no MediaMTX — usado ao
   * DESATIVAR a câmera, para o vídeo parar imediatamente (sem esperar o
   * closeAfter do on-demand). Best-effort: path inexistente é ignorado. */
  async teardownPathsForCamera(cameraId: string): Promise<void> {
    if (!this.isEnabled()) return;
    for (const mode of ['grid', 'grid-audio', 'grid-hevc', 'original', 'original-audio'] as const) {
      const pathName = this.pathNameFromCameraId(cameraId, mode);
      this.pathEnsureCache.delete(this.buildEnsureKey(cameraId, mode));
      await this.apiRequest('DELETE', `/v3/config/paths/delete/${encodeURIComponent(pathName)}`).catch(() => undefined);
      await this.apiRequest(
        'DELETE',
        `/v3/config/paths/delete/${encodeURIComponent(this.privateSourcePathName(pathName))}`,
      ).catch(() => undefined);
    }
    // Limpa também o path-base de compatibilidade criado por versões antigas.
    const legacyPath = `cam_${cameraId.replace(/[^a-zA-Z0-9]/g, '')}`;
    await this.apiRequest('DELETE', `/v3/config/paths/delete/${encodeURIComponent(legacyPath)}`).catch(() => undefined);
    await this.apiRequest('DELETE', `/v3/config/paths/delete/${encodeURIComponent(this.privateSourcePathName(legacyPath))}`).catch(() => undefined);
    this.invalidateMainCodecCache(cameraId);
    await this.sharedRtspSource?.removeCamera(cameraId).catch(() => undefined);
  }

  ensurePathForCamera(cameraId: string, deliveryMode: LiveViewMode = 'original'): Promise<EnsuredCameraPath> {
    const ensureKey = this.buildEnsureKey(cameraId, deliveryMode);
    const cached = this.pathEnsureCache.get(ensureKey);
    if (cached && Date.now() - cached.at < MediamtxProxyService.PATH_ENSURE_TTL_MS) {
      return Promise.resolve(cached.value);
    }

    const existing = this.pathEnsureInFlight.get(ensureKey);
    if (existing) return existing;

    const request = this.configurePathForCamera(cameraId, deliveryMode)
      .then((value) => {
        this.pathEnsureCache.set(ensureKey, { value, at: Date.now() });
        // Avisa o Source Gateway que ESTE perfil tem origem republicada internamente.
        // Sem este aviso o gateway nunca teria o que oferecer e cairia sempre no
        // fallback direto — ou seja, ligar a flag não mudaria nada. Best-effort:
        // um erro aqui NUNCA pode derrubar a preparação do path de live.
        try {
          // Audio variants are delivery outputs, not canonical camera sources.
          // Never let the last audio request replace the shared raw source.
          if (!deliveryMode.endsWith('-audio')) {
            this.sourceGateway?.registerPublishedSource(
              cameraId,
              liveViewModeToSourceProfile(deliveryMode),
              value.pathName ? this.buildInternalRtspUrl(value.pathName) : null,
            );
          }
        } catch {
          /* observabilidade não interfere no live */
        }
        return value;
      })
      .finally(() => {
        if (this.pathEnsureInFlight.get(ensureKey) === request) {
          this.pathEnsureInFlight.delete(ensureKey);
        }
      });
    this.pathEnsureInFlight.set(ensureKey, request);
    return request;
  }

  /**
   * Mantido como estreitamento testável: RTMP não possui um pipeline paralelo.
   * Ele resolve sua origem interna e entra no MESMO configurador de live usado
   * por RTSP (passthrough original, fallback H.264, áudio, grade e limites).
   */
  private configurePushSourcedPath(camera: any, deliveryMode: LiveViewMode) {
    return this.configureResolvedPathForCamera(camera, deliveryMode);
  }

  private async configurePathForCamera(cameraId: string, deliveryMode: LiveViewMode): Promise<EnsuredCameraPath> {
    if (!this.isEnabled()) {
      return {
        pathName: null as string | null,
        sourceUrl: null as string | null,
        sourceVideoCodec: null as string | null,
        transcodedForLive: false,
        liveProfile: null as { channel: number; subtype: number } | null,
        deliveryMode,
      };
    }

    const camera = await this.camerasService.getCameraOrThrow(cameraId);
    // Gate central: câmera desativada não ganha path (nem via warm/watchdog/live).
    // Também derruba paths que já existam, para o vídeo parar na hora.
    if ((camera as { enabled?: boolean }).enabled === false) {
      await this.teardownPathsForCamera(cameraId);
      throw new BadRequestException('Câmera desativada.');
    }
    return this.configureResolvedPathForCamera(camera, deliveryMode);
  }

  private async resolvePushLiveSource(camera: any, rtspTransport: string) {
    let pathName: string | null = null;
    let sourceUrl: string | null = null;
    let codec = String(camera.detectedVideoCodec ?? camera.streamVideoCodec ?? '').trim().toLowerCase() || null;
    let width = Number(camera.detectedWidth ?? camera.streamWidth) || null;
    let height = Number(camera.detectedHeight ?? camera.streamHeight) || null;
    let fps = Number(camera.detectedFps ?? camera.streamFps) || null;
    let bitrateKbps = Number(camera.detectedBitrateKbps ?? camera.streamBitrateKbps) || null;
    let audioCodec: string | null = null;

    if (this.rtmpIngestSource) {
      // Para RTMP não basta conhecer a chave: sem um publisher ativo, criar o
      // path de entrega aponta o MediaMTX para uma origem inexistente. Isso
      // deixava o navegador preso em "Conectando" e ainda gerava tentativas
      // RTSP inúteis a cada poucos segundos. Só montamos o caminho quando há
      // mídia chegando de fato; a próxima abertura a cria assim que o encoder
      // ou aplicativo voltar a publicar.
      const resolved = await this.rtmpIngestSource.resolve(camera, { requireReady: true });
      pathName = resolved.pathName;
      sourceUrl = resolved.sourceUrl;
      codec = resolved.metadata.codec || codec;
      width = resolved.metadata.width ?? width;
      height = resolved.metadata.height ?? height;
      fps = resolved.metadata.fps ?? fps;
      bitrateKbps = resolved.metadata.bitrateKbps ?? bitrateKbps;
      audioCodec = audioCodecFromTracks(resolved.tracks, resolved.ready);
      if (!codec && resolved.ready) {
        codec = await this.probeStreamVideoCodec(sourceUrl!, rtspTransport);
      }
    } else {
      // Compatibilidade com testes unitários que constroem o serviço à mão.
      // Em produção o resolvedor compartilhado acima é sempre injetado.
      if (isAcceptableIngestPath(camera.rtmpIngestPath)) {
        pathName = normalizeIngestPath(camera.rtmpIngestPath);
      } else if (camera.rtmpIngestKeyEncrypted) {
        try {
          const key = this.cryptoService.decrypt(camera.rtmpIngestKeyEncrypted);
          if (isValidIngestKey(key)) {
            const candidates = ingestPathNames(key);
            pathName = candidates[0] ?? null;
            for (const candidate of candidates) {
              if (await this.isPathPublishing(candidate).catch(() => false)) {
                pathName = candidate;
                break;
              }
            }
          }
        } catch {
          pathName = null;
        }
      }
      if (!pathName) {
        throw new BadRequestException('Câmera RTMP ainda não tem chave nem equipamento vinculado.');
      }
      sourceUrl = this.buildInternalRtspUrl(pathName);
      if (!codec && await this.isPathPublishing(pathName).catch(() => false)) {
        codec = await this.probeStreamVideoCodec(sourceUrl!, rtspTransport);
      }
    }

    if (!sourceUrl || !pathName) {
      throw new BadRequestException('Não foi possível resolver a publicação RTMP desta câmera.');
    }

    return {
      profile: null as { channel: number; subtype: number } | null,
      sourceUrl,
      codec,
      width,
      height,
      fps,
      bitrateKbps,
      // Codec desconhecido é tratado conservadoramente como HEVC nos modos que
      // exigem compatibilidade web. Em "original" ele continua em passthrough.
      isHevc: codec ? isHevcCodec(codec) : true,
      requiresSanitization: false,
      ingestPathName: pathName,
      audioCodec,
    };
  }

  /**
   * Configurador comum de entrega. A diferença entre pull e push termina na
   * resolução de `sourceUrl`; daqui em diante ambos obedecem às mesmas regras
   * de passthrough, compatibilidade web, áudio, limites e autocura.
   */
  private async configureResolvedPathForCamera(camera: any, deliveryMode: LiveViewMode): Promise<EnsuredCameraPath> {
    const cameraId = String(camera.id);
    const pushSourced = isPushSourced(camera);

    const password = pushSourced ? '' : this.cryptoService.decrypt(camera.passwordEncrypted);

    const pathName = this.pathNameFromCameraId(cameraId, deliveryMode);
    const encodedPath = encodeURIComponent(pathName);
    const sourceOnDemand = pushSourced
      ? true
      : this.configService.get<boolean>('mediaMtxSourceOnDemand') ?? false;
    const sourceOnDemandStartTimeout = this.configService.get<string>('mediaMtxSourceOnDemandStartTimeout') ?? '6s';
    const sourceOnDemandCloseAfter = this.configService.get<string>('mediaMtxSourceOnDemandCloseAfter') ?? '5m';
    const runOnDemandCloseAfter = this.configService.get<string>('mediaMtxRunOnDemandCloseAfter') ?? '5m';
    const originalRunOnDemandCloseAfter =
      this.configService.get<string>('mediaMtxOriginalRunOnDemandCloseAfter') ?? runOnDemandCloseAfter;
    // A contingência H.264 da grade pode abrir dezenas de encoders de uma vez.
    // Mantê-los por 5 minutos depois que o navegador voltou ao WebRTC/HEVC
    // consome CPU sem nenhum leitor (medido: 15 FFmpegs = ~2,8 núcleos). Um
    // prazo curto ainda absorve remontagens rápidas do tile, mas devolve os
    // núcleos logo depois do fallback. Os demais perfis preservam a retenção
    // configurável existente.
    const effectiveRunOnDemandCloseAfter = deliveryMode === 'grid' || deliveryMode === 'grid-audio'
      ? '20s'
      : runOnDemandCloseAfter;
    const rtspTransport = pushSourced
      ? 'tcp'
      : camera.preferredRtspTransport ?? this.configService.get<string>('ffmpegRtspTransport') ?? 'tcp';

    // Live (tela cheia) respeita o perfil principal configurado. A GRADE usa o
    // sub-stream quando existe (mais leve e rápido); ver chooseGridSource.
    // Com GRID_SOURCE_PROFILE=camera a grade segue a "Fonte da imagem" do
    // cadastro; ativar áudio mantém essa mesma escolha.
    const gridSegueCadastro = gridFollowsCameraProfile(deliveryMode, this.gridSourcePolicy);
    let selected = pushSourced
      ? await this.resolvePushLiveSource(camera, rtspTransport)
      : (deliveryMode === 'grid' || deliveryMode === 'grid-audio' || deliveryMode === 'grid-hevc') && !gridSegueCadastro
        ? await this.chooseGridSource(cameraId, camera, password, rtspTransport)
        : await this.chooseLiveSource(
            cameraId,
            camera,
            password,
            rtspTransport,
            deliveryMode === 'original' || deliveryMode === 'original-audio',
          );
    // Stream 2 com formato diferente do principal (4:3 contra 16:9) vira tarja
    // preta no tile. Na GRADE usamos o principal — MAS SÓ SE ele for H.264, que
    // passa sem conversão. Principal H.265 fica de fora: conversão cara e, em
    // câmera barata, H.265 sujo que não monta quadro nenhum (tela preta a 0 fps
    // medida na IBTelecom, 18/09/2026). Ver gradeDeveUsarPrincipalPorFormato.
    // A variante com áudio aplica a mesma regra de formato.
    if (
      !pushSourced
      && (deliveryMode === 'grid' || deliveryMode === 'grid-hevc' || deliveryMode === 'grid-audio')
      && 'usedSubStream' in selected && selected.usedSubStream
      && streamDiffersInAspect(
        { width: 'width' in selected ? selected.width : null, height: 'height' in selected ? selected.height : null },
        { width: camera.detectedWidth, height: camera.detectedHeight },
      )
    ) {
      const principal = await this.chooseLiveSource(cameraId, camera, password, rtspTransport);
      const trocar = gradeDeveUsarPrincipalPorFormato({
        subDiffersInAspect: true,
        mainCodec: 'codec' in principal ? String(principal.codec ?? '') : null,
        mainIsHevc: principal.isHevc,
      });
      if (!this.gridAspectMismatchLogged.has(cameraId)) {
        this.gridAspectMismatchLogged.add(cameraId);
        const sub = `${'width' in selected ? selected.width : '?'}x${'height' in selected ? selected.height : '?'}`;
        const main = `${camera.detectedWidth}x${camera.detectedHeight}`;
        this.logger.log(
          trocar
            ? `Grade de ${cameraId}: stream 2 ${sub} tem formato diferente do principal ${main} (H.264) — usando o principal para não mostrar tarja.`
            : `Grade de ${cameraId}: stream 2 ${sub} tem formato diferente do principal ${main}, mas o principal é H.265 — `
              + 'mantendo o stream 2 (tarja preta é melhor que converter/arriscar tela preta).',
        );
      }
      if (trocar) selected = principal;
    }
    const liveProfile = selected.profile;
    const sourceUrl = selected.sourceUrl;
    const sharedInput = !pushSourced && this.sharedRtspSource
      ? await this.sharedRtspSource.resolve(cameraId, sourceUrl, rtspTransport)
      : { url: sourceUrl, shared: false };
    const inputTransport = sharedInput.shared ? 'tcp' : rtspTransport;
    const isHevc = selected.isHevc;
    const sourceVideoCodec = String(('codec' in selected ? selected.codec : null) ?? '').trim().toLowerCase()
      || (isHevc ? 'h265' : 'h264');
    const originalDelivery = deliveryMode === 'original' || deliveryMode === 'original-audio';
    const sourceWidth = Number(
      ('width' in selected ? selected.width : null)
      ?? (originalDelivery ? camera.detectedWidth : camera.streamWidth),
    ) || null;
    const sourceHeight = Number(
      ('height' in selected ? selected.height : null)
      ?? (originalDelivery ? camera.detectedHeight : camera.streamHeight),
    ) || null;
    const sourceFps = Number(
      ('fps' in selected ? selected.fps : null)
      ?? (originalDelivery ? camera.detectedFps : camera.streamFps),
    ) || null;
    const sourceBitrateKbps = Number(('bitrateKbps' in selected ? selected.bitrateKbps : null)) || null;
    const usingSubStream = Boolean('usedSubStream' in selected && selected.usedSubStream);
    const sanitizeGridSource =
      (deliveryMode === 'grid' || deliveryMode === 'grid-audio') &&
      !isHevc &&
      Boolean('requiresSanitization' in selected && selected.requiresSanitization);
    // A grade padrão é estritamente vídeo: H.264 compatível segue em
    // passthrough e não abre pipeline de áudio. `*-audio` existe apenas para a
    // câmera única ou para o tile cujo operador escolheu escutar.
    //
    // Modo 'original' (máxima qualidade): NUNCA transcoda — passa o stream
    // principal como está (H.265 inclusive) direto pro HLS. O custo de CPU no
    // servidor é ~0; o celular decodifica o HEVC no hardware. Só HLS (WebRTC não
    // reproduz H.265), com latência maior — é o trade-off assumido pelo usuário.
    const wantsAudio = deliveryMode === 'grid-audio' || deliveryMode === 'original-audio';
    let sourceAudioCodec = 'audioCodec' in selected ? selected.audioCodec : null;
    if (wantsAudio && !pushSourced && sourceAudioCodec == null) {
      const metadata = await this.probeStreamVideoMetadata(sharedInput.url, inputTransport).catch(() => null);
      sourceAudioCodec = metadata?.audioCodec ?? null;
    }
    const audioAvailable = sourceAudioCodec == null ? null : sourceAudioCodec !== 'none';
    const codecPassthroughMode = deliveryMode === 'original' || deliveryMode === 'grid-hevc';
    const needsPublisher = (wantsAudio && audioAvailable !== false) || (!codecPassthroughMode && (isHevc || sanitizeGridSource));
    const originalProfile = resolveOriginalRtspProfile(camera);
    // Só afirmamos equivalência quando a grade NÃO passou por FFmpeg e o perfil
    // físico escolhido é precisamente o que a máxima resolução pediria. Assim o
    // navegador pode ampliar o player existente sem uma nova sessão RTSP/WHEP.
    // Na dúvida (substream, áudio ou conversão), fica false e preserva o caminho
    // seguro já usado hoje.
    const sourceIsOriginal =
      (deliveryMode === 'grid' || deliveryMode === 'grid-hevc')
      && !needsPublisher
      && liveProfile?.channel === originalProfile.channel
      && liveProfile?.subtype === originalProfile.subtype;

    // FREIO: passado o teto, recusa o transcode NOVO em vez de degradar todos.
    //
    // Só vale para quem ainda não tem path — quem JÁ está no ar não é derrubado
    // por um recém-chegado. Sem essa assimetria o freio viraria um revezamento
    // onde ninguém assiste nada, que é pior que a recusa honesta.
    if (needsPublisher && this.activeTranscodes >= this.maxTranscodes) {
      const jaExiste = await this.isPathPublishing(pathName).catch(() => false);
      if (!jaExiste) {
        this.logger.warn(
          `Teto de transcodes atingido (${this.activeTranscodes}/${this.maxTranscodes}): `
          + `câmera ${cameraId} recusada para proteger quem já está assistindo. `
          + 'Fonte H.265 sem sub-stream H.264 é o que puxa esse custo.',
        );
        throw new BadRequestException(
          'Servidor no limite de conversões simultâneas. Feche alguma câmera ou use um navegador com suporte a H.265.',
        );
      }
    }
    // Só é "transcodificado" quando o publisher FFmpeg existe de fato — no modo
    // 'original' (passthrough) a fonte HEVC segue intocada e o rótulo deve refletir isso.
    const transcodedForLive = needsPublisher && (isHevc || wantsAudio);
    // Audio never changes H.264 resolution. Original preserves its codec too;
    // only the compatibility grid needs a HEVC -> H.264 video conversion.
    const videoEncoded = needsPublisher && isHevc && !originalDelivery;
    const audioEncoded = needsPublisher && wantsAudio && audioAvailable !== false && sourceAudioCodec !== 'opus';

    const desiredPath: any = {
      source: sharedInput.url,
      // 'original' (máxima qualidade) puxa o stream PRINCIPAL direto da câmera em
      // passthrough. Sempre sob demanda com janela curta: senão o path seguraria
      // uma sessão RTSP + banda WAN do main 24/7 mesmo sem ninguém assistindo.
      // GRADE: o orçamento quente decide por câmera (ver resolveGridSourceOnDemand).
      // 'original' é sempre sob demanda.
      sourceOnDemand: deliveryMode === 'original' || deliveryMode === 'original-audio'
        ? true
        : deliveryMode === 'grid' || deliveryMode === 'grid-audio'
          ? true
          : deliveryMode === 'grid-hevc'
            ? this.resolveGridSourceOnDemand(cameraId)
          : sourceOnDemand,
      sourceOnDemandStartTimeout,
      sourceOnDemandCloseAfter: deliveryMode === 'original' || deliveryMode === 'original-audio'
        ? originalRunOnDemandCloseAfter
        : sourceOnDemandCloseAfter,
      rtspTransport: inputTransport,
    };

    if (needsPublisher) {
      // ENTRADA DO FFMPEG: DIRETO NA CÂMERA (padrão) ou pelo path privado.
      //
      // Em 28/07 o `-i` passou a apontar para um path privado do MediaMTX em vez
      // da câmera, para tirar usuário e senha da linha de comando (elas apareciam
      // em `ps aux`, no log e na config). A intenção era certa, mas inseriu um
      // repasse RTSP inteiro no caminho do vídeo — e sob rede instável esse
      // repasse republica H.265 com referências faltando, o que derruba o FPS e
      // apaga o tile. Em produção o custo superou o ganho, e o dono decidiu pela
      // estabilidade: o padrão volta a ser o caminho DIRETO de 21/07.
      //
      // O que NÃO se perdeu: a redação de credencial em log segue ativa
      // (common/security/sensitive-text.helper). O que se perde: quem tiver
      // shell no host volta a ver a senha em `ps aux` — mesmo modelo do Frigate,
      // que também passa a credencial no comando e trata a exposição na saída.
      //
      // Reversível sem tocar em código: MEDIAMTX_PRIVATE_SOURCE_HOP=true.
      const privateSourceUrl = sharedInput.shared
        ? this.buildInternalPublishRtspUrl(new URL(sharedInput.url).pathname.slice(1)) : !pushSourced && this.usePrivateSourceHop
        ? `rtsp://127.0.0.1:$RTSP_PORT/${await this.ensurePrivateSourcePath(
          pathName,
          sourceUrl,
          rtspTransport,
          sourceOnDemandStartTimeout,
          sourceOnDemandCloseAfter,
        )}`
        : sourceUrl;
      // Este ramo é a contingência H.264 ou a sanitização da grade. Clientes que
      // reproduzem H.265 usam `grid-hevc`/`original` e não chegam aqui. Quando o
      // publisher é necessário, ele publica H.264 + Opus para ampla compatibilidade.
      desiredPath.source = 'publisher';
      // O publisher tambem normaliza H.264 quando ja precisa abrir FFmpeg para
      // a fonte exige sanitização. Copiar um stream com fragmentos RTP perdidos repassa quadros
      // quebrados ao navegador e pode deixar a imagem verde ate o proximo IDR.
      // A grade limita fontes grandes, mas preserva a resolução nativa de fontes
      // menores. Sem o min(iw/ih), um sub-stream 640x360 era ampliado para
      // 1280x720: mais custo de encode sem criar detalhe real.
      const gridScaleFilter =
        `scale=w='min(iw,${GRID_LIVE_MAX_WIDTH})':h='min(ih,${GRID_LIVE_MAX_HEIGHT})':` +
        `force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `fps=${GRID_LIVE_TARGET_FPS}`;
      // O substream H.264 já leve não é reencodado. A grade copia quando nada
      // mudaria. O filtro dela é um TETO
      // (`scale=min(iw,640)`), não um alvo: fonte que já cabe atravessa
      // intocada. Medido nas 4 câmeras do dono — substream 640×360 @20 H.264,
      // exatamente o teto — decodificava e reencodava para produzir o mesmo
      // vídeo. "isso é retrabalho e jogar % da cpu no lixo!!!" (14/08/2026)
      // O Instantâneo (`grid-audio`) também copia o stream 2 quando ele é H.264
      // e já está em até 480p: zero encode de vídeo; se houver AAC, o FFmpeg
      // converte apenas o áudio para Opus. Sem stream 2 adequado, reduzimos o
      // principal para 360p dentro do orçamento de 400–700 kbps.
      const copyCeiling = deliveryMode === 'grid-audio'
        ? { larguraMaxima: 854, alturaMaxima: 480, fpsAlvo: GRID_LIVE_TARGET_FPS }
        : { larguraMaxima: GRID_LIVE_MAX_WIDTH, alturaMaxima: GRID_LIVE_MAX_HEIGHT, fpsAlvo: GRID_LIVE_TARGET_FPS };
      const copiaNaGrade = (deliveryMode === 'grid' || (deliveryMode === 'grid-audio' && usingSubStream))
        ? decidirCopiaDeVideo(
            {
              codec: sourceVideoCodec,
              largura: sourceWidth,
              altura: sourceHeight,
              fps: sourceFps,
            },
            copyCeiling,
          )
        : { copiar: false, motivo: 'nao-e-grade' as const };
      if (copiaNaGrade.copiar) {
        this.logger.log(`Grade de ${cameraId} COPIA o vídeo (${sourceWidth}x${sourceHeight} H.264 já cabe) — sem reencode.`);
      }
      const videoJaServe = !videoEncoded;
      const instantBitrateKbps = resolveInstantBitrateKbps({
        // Stable policy: scene-dependent arrival bitrate must not rebuild paths.
        sourceBitrateKbps: null,
        sourceWidth,
        sourceHeight,
        outputWidth: GRID_LIVE_MAX_WIDTH,
        outputHeight: GRID_LIVE_MAX_HEIGHT,
        ceilingKbps: INSTANT_LIVE_MAX_BITRATE_KBPS,
      });
      const deliveryBitrateKbps = deliveryMode === 'grid-audio'
        ? instantBitrateKbps
        : GRID_LIVE_BITRATE_KBPS;
      const videoArgs = (sanitizeGridSource && deliveryMode === 'grid') || videoJaServe
        ? '-c:v copy'
        :
        // `veryfast`, não `ultrafast`: o preset mais rápido do x264 degradava
        // visivelmente a grade (aspecto lavado e fantasma). O teto é 900 kbps
        // na grade e 700 kbps no Instantâneo, com CRF (qualidade variável),
        // não bitrate médio fixo.
        // Forçar `-b:v 900k` fazia uma cena parada do Instantâneo gastar perto
        // de 900 kbps enquanto o original VBR da própria câmera caía a 100 kbps
        // — exatamente o inverso do propósito do modo leve. CRF reduz a taxa
        // quando não há detalhe/movimento e o VBV impede ultrapassar o teto.
        //
        //   ultrafast  SSIM 0,9794  PSNR 40,52 dB   0,15 s   <- causava a queixa
        //   veryfast   SSIM 0,9851  PSNR 41,58 dB   0,22 s
        // `-refs 2` (era 1) devolve a referência que o x264 usa
        // para não borrar objeto em movimento — o "fantasma" da queixa.
          '-threads 2 -c:v libx264 -preset veryfast -tune zerolatency -profile:v main ' +
          `-crf 23 -maxrate ${deliveryBitrateKbps}k ` +
          `-bufsize ${deliveryBitrateKbps}k -pix_fmt yuv420p ` +
          `-g 30 -keyint_min 15 -sc_threshold 0 -bf 0 -refs 2 -vf "${gridScaleFilter}"`;
      // `?` não falha em câmeras sem microfone. Quando há áudio, Opus garante
      // reprodução WebRTC em Chrome, Firefox, Edge e Safari; sem isto o AAC da
      // origem aparece no MediaMTX, mas frequentemente não chega tocável ao
      // navegador. Quando o operador não o escuta, o <video> permanece muted.
      const audioArgs = wantsAudio
        ? (sourceAudioCodec === 'opus' ? '-map 0:a:0? -c:a copy' : '-map 0:a:0? -c:a libopus -b:a 64k -ac 1 -ar 48000')
        : '-an';
      // MediaMTX preenche $MTX_PATH e $RTSP_PORT automaticamente para o script.
      // -threads 4: limita libx264 a 4 threads por câmera (3 câmeras × 4 = 12 threads totais).
      // Sem este limite, libx264 cria automaticamente N threads = nº de núcleos lógicos,
      // causando 3 × 14 = 42 threads encode + 3 × 15 = 45 threads decode competindo,
      // sobrecarregando C0/C1 por efeito de scheduler clustering.
      const publishUrl = this.buildInternalPublishRtspUrl(pathName);
      const buildFfmpegCommand = (videoArgs: string) =>
        `ffmpeg -nostdin -hide_banner -loglevel warning -fflags +genpts+discardcorrupt+nobuffer ` +
        // -analyzeduration/-probesize: o padrão do FFmpeg analisa até 5s/5MB do input
        // antes de começar a transcodificar. Para câmeras H.264/H.265 conhecidas isso é
        // exagero e adiciona vários segundos ao COLD START (quando o runOnDemand reabre
        // após os 5 min de runOnDemandCloseAfter). 1s/1MB já identifica o stream com
        // folga e corta esse atraso, deixando o retorno à câmera bem mais rápido.
        // +nobuffer evita o buffer de entrada extra do FFmpeg (menor latência ao vivo).
        `-analyzeduration 1000000 -probesize 1000000 ` +
        // careful: validates bitstream integrity and drops malformed packets
        // instead of passing corrupted NAL units downstream (which causes
        // green frames in the browser until the next IDR keyframe arrives).
        `-flags low_delay -err_detect careful -rtsp_transport ${inputTransport} ` +
        `-i "${privateSourceUrl}" -map 0:v:0 ${videoArgs} ${audioArgs} ` +
        `-f rtsp -rtsp_transport tcp -muxdelay 0.1 -pkt_size 1200 "${publishUrl}"`;
      const ffmpegCommand = buildFfmpegCommand(videoArgs);
      // AUTO-RECUPERAÇÃO (anti-travamento). Antes de iniciar o restream, mata
      // qualquer ffmpeg ENCRAVADO deste MESMO path. Um ffmpeg que parou de publicar
      // mas continuou vivo segurava o antigo lock `flock -n` e fazia todo runOnDemand
      // seguinte falhar em silêncio → loop infinito "Nenhum protocolo iniciou". Aqui
      // não há lock para travar: cada start limpa o que ficou e sobe um processo novo.
      //
      // Segurança: só elimina processos cujo comm é exatamente `ffmpeg` E cuja linha
      // de comando publica NESTE path (`/<pathName> ` — o publishUrl é o último arg,
      // então é seguido pelo NUL final que vira espaço; o sufixo `_grid` distingue
      // o path da grade do original, evitando matar o path irmão). O runOnDemand só roda quando
      // o path está SEM fonte, então o publisher ativo nunca é alvo.
      const prekill =
        `for d in /proc/[0-9]*; do ` +
        `c=$(cat "$d/comm" 2>/dev/null); [ "$c" = ffmpeg ] || continue; ` +
        `tr "\\0" " " < "$d/cmdline" 2>/dev/null | grep -qF "/${pathName} " ` +
        `&& kill -9 "$(basename "$d")" 2>/dev/null; ` +
        `done`;
      // MediaMTX expands dollar variables before shell evaluation. Decode the
      // local-only cleanup script at execution time so $d/$c are not erased.
      const prekillHook = `printf %s ${Buffer.from(prekill).toString('base64')} | base64 -d | sh`;
      const conversionCost = liveConversionCost({
        videoEncoded, codec: sourceVideoCodec, width: sourceWidth, height: sourceHeight, fps: sourceFps,
      });
      const admitted = withWeightedTranscodeAdmission(ffmpegCommand, this.maxTranscodePoints, conversionCost);
      // The outer helper execs a shell so its process-count lock survives too.
      const runOnDemandScript = `${prekillHook}; ${withTranscodeAdmission(`sh -c ${this.shellQuote(admitted)}`, this.maxTranscodes)}`;
      desiredPath.runOnDemand = `sh -c ${this.shellQuote(runOnDemandScript)}`;
      // FFMPEG ÓRFÃO: o mesmo prekill, agora também na SAÍDA do último espectador.
      //
      // PROVADO por experimento (31/07): apagar o path (`DELETE`) NÃO mata o
      // ffmpeg que o MediaMTX havia iniciado — e alterar por `PATCH` também não.
      // Como toda reconfiguração da grade faz delete+add, cada deploy deixava
      // para trás um ffmpeg sem dono: medidos 17 vivos há 24,5 h, somando 45% de
      // CPU e — o que importa de verdade — segurando 17 sessões RTSP no DVR do
      // cliente. Câmera OEM aceita de 2 a 4 sessões; com as vagas ocupadas por
      // processos fantasma, as conexões legítimas passam a levar
      // "Connection refused", e o operador vê a frota inteira cair em bloco.
      //
      // O prekill já existia, mas só rodava quando um ffmpeg NOVO subia — ou
      // seja, o órfão só era limpo se alguém voltasse a abrir aquela câmera.
      // Câmera não revisitada ficava com o fantasma para sempre.
      //
      // `runOnUnDemand` fecha o ciclo: ao sair o último leitor, o MediaMTX roda
      // este comando e nada daquele path sobrevive. Custa uma varredura em
      // /proc por câmera, apenas quando ela fica ociosa.
      desiredPath.runOnUnDemand = `sh -c ${this.shellQuote(prekillHook)}`;
      desiredPath.runOnDemandRestart = false;
      desiredPath.runOnDemandStartTimeout = '15s'; // Tempo para o ffmpeg começar a republicar.
      // Mantém o restream recente aquecido. Assim, voltar para uma câmera não
      // exige iniciar FFmpeg e aguardar um novo keyframe outra vez.
      desiredPath.runOnDemandCloseAfter = effectiveRunOnDemandCloseAfter;
      // Com runOnDemand como publisher, estes campos 'sourceOnDemand' são inválidos.
      delete desiredPath.sourceOnDemand;
      delete desiredPath.sourceOnDemandStartTimeout;
      delete desiredPath.sourceOnDemandCloseAfter;
    }

    try {
      const current: any = await this.getPath(pathName);
      // A direct passthrough still serving viewers drains before moving to its
      // equivalent shared raw generation. Explicit camera edits still apply.
      if (sharedInput.shared && current.source === sourceUrl && current.source !== desiredPath.source) {
        let active = true;
        try {
          const runtime = JSON.parse(await this.apiRequest('GET', `/v3/paths/get/${encodedPath}`));
          active = !Array.isArray(runtime.readers) || runtime.readers.length > 0;
        } catch (error: any) { if (Number(error.status) === 404) active = false; }
        if (active) return {
          pathName, sourceUrl, sourceVideoCodec, transcodedForLive: false,
          videoEncoded: false, audioEncoded: false, liveProfile, deliveryMode, sourceIsOriginal,
        };
      }
      const hasSameSource =
        current.source === desiredPath.source &&
        current.rtspTransport === desiredPath.rtspTransport;
      const hasSameCameraSourceSettings = needsPublisher
        ? true
        : current.sourceOnDemand === desiredPath.sourceOnDemand &&
          this.sameDuration(current.sourceOnDemandStartTimeout, desiredPath.sourceOnDemandStartTimeout) &&
          this.sameDuration(current.sourceOnDemandCloseAfter, desiredPath.sourceOnDemandCloseAfter);
      const hasSamePublisherSettings = needsPublisher
        ? (current.runOnDemand || '') === (desiredPath.runOnDemand || '') &&
          // Sem comparar o runOnUnDemand, um path já existente NUNCA receberia a
          // limpeza de órfão: seria visto como "igual" e a atualização pulada.
          (current.runOnUnDemand || '') === (desiredPath.runOnUnDemand || '') &&
          Boolean(current.runOnDemandRestart) === Boolean(desiredPath.runOnDemandRestart) &&
          this.sameDuration(current.runOnDemandStartTimeout, desiredPath.runOnDemandStartTimeout) &&
          this.sameDuration(current.runOnDemandCloseAfter, desiredPath.runOnDemandCloseAfter)
        : true;
      const isSamePath = hasSameSource && hasSameCameraSourceSettings && hasSamePublisherSettings;

      // A policy refresh must not evict viewers of the same physical source.
      // Explicit source/credential changes still apply; only defer tuning of
      // the existing publisher, and report its ACTUAL operations while draining.
      if (!isSamePath && needsPublisher && hasSameSource
        && (String(current.runOnDemand ?? '').includes(sourceUrl)
          || (sharedInput.shared && String(current.runOnDemand ?? '').includes(new URL(sharedInput.url).pathname)))) {
        let inUse = true; // Control-plane failure must not interrupt viewers.
        try {
          const runtime = JSON.parse(await this.apiRequest('GET', `/v3/paths/get/${encodedPath}`));
          inUse = Array.isArray(runtime.readers) && runtime.readers.length > 0;
        } catch (error: any) {
          if (Number(error?.status) === 404) inUse = false;
        }
        if (inUse) {
          return {
            pathName, sourceUrl, sourceVideoCodec, transcodedForLive, liveProfile,
            deliveryMode, sourceIsOriginal,
            videoEncoded: /-c:v (?!copy\b)\S+/.test(current.runOnDemand),
            audioEncoded: /-c:a (?!copy\b)\S+/.test(current.runOnDemand),
          };
        }
      }

      if (isSamePath) {
        return {
          pathName,
          sourceUrl,
          sourceVideoCodec,
          transcodedForLive,
          videoEncoded,
          audioEncoded,
          audioAvailable,
          liveProfile,
          deliveryMode,
          sourceIsOriginal,
        };
      }
    } catch (error: any) {
      // SÓ 404 significa "não existe, pode criar".
      //
      // Antes, QUALQUER erro caía aqui e seguia para DELETE + POST. Mas timeout,
      // 5xx, 401 ou JSON inválido descrevem "não consegui LER a configuração" —
      // e o path pode estar vivo, com gente assistindo. Apagá-lo derruba todos os
      // leitores por causa de um soluço do plano de controle.
      //
      // Na dúvida, não muta: devolve o que já sabemos e tenta de novo no próximo
      // ciclo. Path realmente errado é reconciliado então; path saudável sobrevive.
      const status = Number(error?.status);
      if (status !== 404) {
        this.logger.warn(
          `Não foi possível ler a configuração de ${pathName} (${error?.message ?? 'erro desconhecido'}) — ` +
          'path preservado; nada foi recriado.',
        );
        return {
          pathName,
          sourceUrl,
          sourceVideoCodec,
          transcodedForLive,
          videoEncoded,
          audioEncoded,
          audioAvailable,
          liveProfile,
          deliveryMode,
          sourceIsOriginal,
        };
      }
    }

    // Só recria quando a configuração mudou; recriar em toda leitura derruba muxers HLS/WebRTC ativos.
    try {
      await this.apiRequest('DELETE', `/v3/config/paths/delete/${encodedPath}`);
    } catch {
      // ignora quando ainda não existe
    }

    await this.apiRequest('POST', `/v3/config/paths/add/${encodedPath}`, desiredPath);

    this.logger.log(`Path MediaMTX pronto ${pathName} -> ${this.sanitizeRtspUrl(sourceUrl)}`);
    return {
      pathName,
      sourceUrl,
      sourceVideoCodec,
      transcodedForLive,
      videoEncoded,
      audioEncoded,
      audioAvailable,
      liveProfile,
      deliveryMode,
      sourceIsOriginal,
    };
  }


  /**
   * A ingestão deste caminho está de pé AGORA?
   *
   * Usado como sinal de saúde da câmera que publica: enquanto o equipamento
   * manda, o path existe e está pronto. Falha de consulta lança, para quem
   * chama distinguir "não está publicando" de "não consegui perguntar" — tratar
   * os dois igual marcaria a frota inteira como offline num soluço do MediaMTX.
   */
  async isPathPublishing(pathName: string): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const texto = await this.apiRequest('GET', `/v3/paths/get/${encodeURIComponent(pathName)}`);
    const info = JSON.parse(texto) as { ready?: boolean; source?: { type?: string } | null };
    return info?.ready === true;
  }

  buildInternalRtspUrl(pathName: string | null) {
    if (!pathName) return null;
    const base = (this.configService.get<string>('mediaMtxRtspInternalUrl') ?? 'rtsp://mediamtx:8554').replace(/\/+$/, '');
    const apiUser = (this.configService.get<string>('mediaMtxApiUser') ?? '').trim();
    const apiPass = (this.configService.get<string>('mediaMtxApiPass') ?? '').trim();
    if (!apiUser || !apiPass) {
      throw new Error('Credenciais internas do MediaMTX não configuradas (MEDIAMTX_API_USER/MEDIAMTX_API_PASS).');
    }

    const parsed = new URL(`${base}/${encodeURIComponent(pathName)}`);
    // O MediaMTX usa autenticação HTTP também para leitores RTSP internos. Sem
    // estas credenciais, IA/posters recebem 401 mesmo dentro da rede Docker.
    if (!parsed.username) parsed.username = apiUser;
    if (!parsed.password) parsed.password = apiPass;
    return parsed.toString();
  }

  buildPublicUrls(req: Request, pathName: string | null, sourceUrl: string | null): DeliveryUrls {
    const enabled = this.isEnabled() && Boolean(pathName);
    if (!enabled || !pathName) {
      return {
        enabled: false,
        pathName: null,
        sourceUrl,
        webrtcUrl: null,
        whepUrl: null,
        hlsUrl: null,
        rtspProxyUrl: null,
      };
    }

    const hostHeader = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
    const requestHost = hostHeader.split(',')[0].trim().split(':')[0];
    const host = this.configService.get<string>('mediaMtxPublicHost') || requestHost || 'localhost';
    const reqProto = ((req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http')
      .split(',')[0]
      .trim();
    const scheme = this.configService.get<string>('mediaMtxPublicScheme') || reqProto || 'http';
    const configuredWebrtcBase = (this.configService.get<string>('mediaMtxPublicWebrtcUrl') ?? '').replace(/\/+$/, '');
    const configuredHlsBase = (this.configService.get<string>('mediaMtxPublicHlsUrl') ?? '').replace(/\/+$/, '');
    const webrtcPort = this.configService.get<number>('mediaMtxWebrtcPort') ?? 8889;
    const hlsPort = this.configService.get<number>('mediaMtxHlsPort') ?? 8888;

    // ── PÁGINA HTTPS NÃO PODE RECEBER URL http://IP:8889 ────────────────────────
    //
    // Diagnosticado no D-GUARDIAN (12/08/2026), tile eterno em "Conectando":
    // a página abre em https://<domínio>, mas a entrega era anunciada como
    // http://<IP>:8889 — e o navegador BLOQUEIA "http dentro de https" (conteúdo
    // misto). A requisição WHEP nem saía do navegador, então o servidor não via
    // nada: parecia a câmera não conectar, quando o stream estava perfeito.
    //
    // Trocar o esquema para https://<IP>:8889 não resolve: a 8889 fala HTTP puro,
    // não tem TLS, e o certificado é do domínio, não do IP. A ÚNICA URL que um
    // navegador em página HTTPS aceita é a MESMA ORIGEM, atrás do nginx — que já
    // repassa /webrtc/→8889 e /hls/→8888. Por isso, sob HTTPS, entregamos por
    // caminho na origem (sem porta), não por http://IP:porta.
    //
    // Config explícita (MEDIAMTX_PUBLIC_WEBRTC_URL/HLS_URL) continua vencendo,
    // para quem quer apontar para outro host de mídia.
    const entregaMesmaOrigemHttps = reqProto === 'https';
    const webrtcBase =
      configuredWebrtcBase ||
      (entregaMesmaOrigemHttps ? `https://${requestHost}/webrtc` : `${scheme}://${host}:${webrtcPort}`);
    const hlsBase =
      configuredHlsBase ||
      (entregaMesmaOrigemHttps ? `https://${requestHost}/hls` : `${scheme}://${host}:${hlsPort}`);

    return {
      enabled: true,
      pathName,
      sourceUrl,
      webrtcUrl: `${webrtcBase}/${pathName}/`,
      whepUrl: `${webrtcBase}/${pathName}/whep`,
      hlsUrl: `${hlsBase}/${pathName}/index.m3u8`,
      rtspProxyUrl: `rtsp://${host}:8554/${pathName}`,
    };
  }
}
