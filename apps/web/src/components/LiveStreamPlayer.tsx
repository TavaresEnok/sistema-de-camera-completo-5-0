import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import axios from 'axios';
import { AlertTriangle, LoaderCircle, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { useAiPreferencesStore } from '../store/aiPreferencesStore';
import { streamUrlsCache } from '../lib/stream-urls-cache';
import { liveDetectionsPoller } from '../lib/live-detections-poller';
import { SmoothDetectionOverlay } from './SmoothDetectionOverlay';
import { useRedeStore } from '../store/redeStore';
import { classificarFalhaDePlayer } from '../lib/qualidade-de-rede';
import {
  buildLiveProtocolOrder,
  hasWebrtcInboundProgress,
  liveProtocolStorageKey,
  shouldRetryWebrtcStartup,
  shouldUseGridH264Fallback,
  videoCodecFamily,
  type LiveDeliveryMode,
  type LiveProtocol,
  type WebrtcInboundSample,
} from '../lib/live-protocol-policy';
import { discoverWhepIceServers } from '../lib/whep-ice-servers';

type LiveStreamPlayerProps = {
  cameraId: string;
  cameraName: string;
  className?: string;
  autoPlay?: boolean;
  muted?: boolean;
  showOverlay?: boolean;
  aiEnabled?: boolean;
  liveViewMode?: 'selected' | 'grid';
  startDelayMs?: number;
  /** A rota que contém o player está realmente visível na SPA. */
  routeActive?: boolean;
  onStatusChange?: (status: LivePlayerStatus) => void;
  /** A API confirmou que a fonte efetiva da grade já é a fonte original. */
  onGridSourceIsOriginal?: (isOriginal: boolean) => void;
};

const API_URL = getApiBaseUrl();
const HLS_FIRST_FRAME_TIMEOUT_MS = 7000;
const WEBRTC_FIRST_FRAME_TIMEOUT_MS = 8000;
const WEBRTC_WHEP_NEGOTIATION_TIMEOUT_MS = 9500;
// Depois que a conexão WebRTC ESTABELECE (ICE connected) mas o primeiro frame ainda
// não chegou, quase sempre é o FFmpeg do path fazendo cold start: o runOnDemand foi
// encerrado após runOnDemandCloseAfter (5 min sem espectador) e precisa reabrir o RTSP,
// fazer probe e aguardar um keyframe. O timeout normal de 8s estoura no meio desse
// arranque, faz o cliente desistir do WebRTC, cair para HLS (+7s) e entrar em backoff —
// é esse empilhamento que levava a reconexão ao voltar para a aba a ~20s. Quando
// detectamos "conectou, mas sem frame", estendemos o prazo para o publisher esquentar
// e o vídeo volta no MESMO WebRTC, sem thrashing.
const WEBRTC_COLD_START_FRAME_TIMEOUT_MS = 17000;
const WEBRTC_DISCONNECT_GRACE_MS = 6000;
const LIVE_RESUME_GRACE_MS = 1200;
const LIVE_SOFT_ONLY_RESUME_MS = 120000;
// Após este tempo com a aba oculta, derruba o WebRTC para parar o transcode no
// servidor e o tráfego de rede de uma aba que ninguém está vendo. Como o MediaMTX
// mantém o FFmpeg aquecido por runOnDemandCloseAfter (5 min), voltar dentro dessa
// janela reconecta quase instantaneamente, sem boot frio.
const LIVE_HIDDEN_SUSPEND_MS = 45000;
const LIVE_STALL_CHECK_INTERVAL_MS = 4000;
const LIVE_STALL_SOFT_RECOVER_MS = 8000;
const LIVE_STALL_RECONNECT_MS = 16000;
const LIVE_RECONNECT_DEBOUNCE_MS = 2500;
const LIVE_FAST_RETRY_BASE_MS = 1200;
const LIVE_FAST_RETRY_MAX_MS = 7000;
// A câmera pode chegar ao SRS alguns instantes antes de o MediaMTX anunciar a
// origem interna. Recuperamos essa janela automaticamente, mas paramos após
// tentativas suficientes para uma fonte realmente desligada não virar spinner.
const RTMP_SOURCE_AUTO_RETRY_LIMIT = 4;
const RTMP_SOURCE_BACKGROUND_RETRY_MS = 15_000;
const LIVE_EDGE_OFFSET_SECONDS = 0.35;
// Recuperação de latência sem salto (técnica do Frigate): acima de 1,2s de
// deriva a reprodução acelera suavemente (teto 1,5×) até reencostar no ao vivo;
// só deriva grande (8s+, ex.: volta de aba oculta) justifica o salto seco.
const LIVE_DRIFT_CATCHUP_SECONDS = 1.2;
const LIVE_DRIFT_HARD_SEEK_SECONDS = 8;
const LIVE_DRIFT_MAX_RATE = 1.5;
// Tempo sem NENHUM frame novo apresentado (rVFC) antes de reconectar. É o único
// detector de congelamento real agora, então precisa tolerar câmeras com "smart
// codec" que reduzem muito a taxa de quadros em cena 100% estática (alguns enviam
// ~1 frame a cada vários segundos). 10s era apertado demais e podia reconectar uma
// câmera saudável de baixa atividade. 20s cobre congelamento real sem falso-positivo.
const LIVE_RENDER_STALL_RECONNECT_MS = 20000;
// No WebRTC, vivacidade vem de inbound-rtp. O compositor pode deixar de chamar
// rVFC com muitos tiles sem que um único pacote tenha parado. Trinta segundos
// sem frame RTP decodificado é falha real suficiente para refazer o MESMO
// WebRTC; fallback de protocolo continua reservado à falha de startup.
const WEBRTC_RTP_STALL_RECONNECT_MS = 30000;
const LIVE_BLACK_FRAME_FAILOVER_MS = 6000;
const LIVE_VIEW_LEASE_TTL_SECONDS = 20;
const LIVE_VIEW_HEARTBEAT_MS = 7000;
const WEBRTC_HEVC_PROOF_STORAGE_KEY = 'drac-live-capability:webrtc-hevc:v1';
const WEBRTC_HEVC_PROOF_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const STREAM_URL_CACHE_TTL_MS = 60 * 1000;
type ActiveLiveProtocol = 'WEBRTC' | 'LL-HLS' | 'HLS';
// Qualidade escolhida pelo operador na visualização de câmera única (1x1):
//  - instant  → sub-stream (mesmo da grade): latência mínima, zero CPU, imagem reduzida
//  - max      → principal ORIGINAL sem transcode (HEVC incluso): zero CPU, qualidade
//               idêntica à câmera; sem suporte a HEVC, volta ao Instantâneo.
type LiveQualityMode = 'instant' | 'max';
function hasWebrtcHevcProof() {
  try {
    const provedAt = Number(window.localStorage.getItem(WEBRTC_HEVC_PROOF_STORAGE_KEY));
    return Number.isFinite(provedAt) && provedAt > 0 && Date.now() - provedAt <= WEBRTC_HEVC_PROOF_TTL_MS;
  } catch {
    return false;
  }
}

function storeWebrtcHevcProof() {
  try {
    window.localStorage.setItem(WEBRTC_HEVC_PROOF_STORAGE_KEY, String(Date.now()));
  } catch {
  }
}

// Suporte do navegador a H.265 para o modo "Máxima qualidade" (avaliado uma vez).
const WEBRTC_DECODES_HEVC = (() => {
  try {
    const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? [];
    return codecs.some((codec) => /h265|hevc/i.test(codec.mimeType));
  } catch {
    return false;
  }
})();
const MSE_DECODES_HEVC = (() => {
  try {
    return typeof MediaSource !== 'undefined' && (
      MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L123.B0"')
      || MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L123.B0"')
    );
  } catch {
    return false;
  }
})();
// Este navegador consegue exibir H.265 por ALGUM caminho? Se não, o modo "Máxima"
// (H.265 original) cai automaticamente para "Instantâneo" (H.264).
const BROWSER_DECODES_HEVC = WEBRTC_DECODES_HEVC || MSE_DECODES_HEVC;
export type LivePlayerStatus = {
  activeProtocol: ActiveLiveProtocol | null;
  state: 'loading' | 'playing' | 'fallback' | 'error';
  reason: string | null;
};
type HlsController = {
  destroy: () => void;
  startLoad?: (startPosition?: number) => void;
  recoverMediaError?: () => void;
  liveSyncPosition?: number | null;
};

type CommercialRestrictionError = {
  error?: string;
  userMessage?: string;
  adminMessage?: string;
};

type LiveDiagnostics = {
  generatedAt?: string;
  mediamtxEnabled?: boolean;
  pathReady?: boolean;
  pathName?: string | null;
  publicAppUrl?: string | null;
  apiPublicUrl?: string | null;
  mediaMtxPublicHost?: string | null;
  mediaMtxPublicScheme?: string | null;
  mediaMtxPublicWebrtcUrl?: string | null;
  mediaMtxPublicHlsUrl?: string | null;
  mediaMtxWebrtcAllowOrigin?: string | null;
  mediaMtxHlsAllowOrigin?: string | null;
  sourceVideoCodec?: string | null;
  liveTranscodedForBrowser?: boolean;
  readiness?: {
    state?: 'ready' | 'degraded' | 'blocked';
    readyForWebrtc?: boolean;
    fallbackAvailable?: boolean;
    userMessage?: string | null;
    recommendedAction?: string | null;
  } | null;
};

type PlaybackProgress = {
  wallTime: number;
  mediaTime: number;
};

type LiveDetection = {
  id: string;
  type: string;
  label: string;
  confidence: number | null;
  similarity: number | null;
  bbox: [number, number, number, number];
  frameWidth: number | null;
  frameHeight: number | null;
  occurredAt: string;
  overlayMode?: string | null;
  trackId?: number | null;
};

// Mensagens internas de falha citam protocolo/infra (WebRTC, WHEP, MediaMTX…).
// Isso é útil em log/diagnóstico, mas NUNCA deve ser a mensagem principal para o
// operador — ele não é técnico. Na UI mostramos um texto humano e o detalhe
// técnico fica recolhido em "Detalhes técnicos".
const TECHNICAL_LIVE_MESSAGE_REGEX = /protocolo|webrtc|whep|hls|mediamtx|codec|sdp|token|stream|ffmpeg|ice|manifesto/i;

function friendlyLiveText(raw: string | null, fallback: string) {
  if (!raw) return fallback;
  return TECHNICAL_LIVE_MESSAGE_REGEX.test(raw) ? fallback : raw;
}

// A preferência aprendida VENCE. Sem prazo, uma única falha passageira de WebRTC
// (queda de link, servidor reiniciando) fixava aquela câmera em HLS naquele
// navegador PARA SEMPRE: como o HLS funciona, o WebRTC nunca mais era tentado, e
// o operador ficava com latência alta mesmo depois de a infraestrutura sarar.
//
// Doze horas cobrem um turno inteiro — dentro do turno vale o fato observado
// (nada de repetir tentativa fracassada a cada tile); no turno seguinte, o
// protocolo principal é reavaliado uma vez.
const LIVE_PROTOCOL_TTL_MS = 12 * 60 * 60 * 1000;

// Prazo do GET /urls. Generoso o bastante para caber uma abertura fria legítima,
// curto o bastante para que um tile travado não segure os outros por minutos.
const LIVE_URLS_TIMEOUT_MS = 20_000;
// Prazo do DELETE da sessão WHEP na limpeza. É cortesia com o servidor, não
// pré-requisito: esperar por ela atrasa a PRÓXIMA conexão do operador.
const WHEP_DELETE_TIMEOUT_MS = 2_000;

function getStoredProtocol(
  cameraId: string,
  deliveryMode: LiveDeliveryMode,
  sourceCodec?: string | null,
): LiveProtocol | null {
  try {
    const raw = window.localStorage.getItem(liveProtocolStorageKey(cameraId, deliveryMode, sourceCodec));
    if (!raw) return null;
    // A chave v2 inclui modo de entrega e família do codec. Valores antigos e
    // sem contexto são deliberadamente ignorados: foi justamente essa mistura
    // que fez preferências de HLS da grade contaminarem outras visualizações.
    // O timestamp ainda impede que uma falha passageira vire preferência eterna.
    const [valor, gravadoEm] = raw.split('|');
    if (gravadoEm) {
      const idade = Date.now() - Number(gravadoEm);
      if (!Number.isFinite(idade) || idade < 0 || idade > LIVE_PROTOCOL_TTL_MS) return null;
    }
    const normalized = valor === 'll-hls' ? 'llhls' : valor;
    return normalized === 'webrtc' || normalized === 'hls' || normalized === 'llhls' ? normalized : null;
  } catch {
    return null;
  }
}

function storeProtocol(
  cameraId: string,
  protocol: ActiveLiveProtocol,
  deliveryMode: LiveDeliveryMode,
  sourceCodec?: string | null,
) {
  try {
    const normalized = protocol === 'LL-HLS' ? 'llhls' : protocol.toLowerCase();
    window.localStorage.setItem(
      liveProtocolStorageKey(cameraId, deliveryMode, sourceCodec),
      `${normalized}|${Date.now()}`,
    );
  } catch {
  }
}

function normalizeActiveProtocol(protocol: ActiveLiveProtocol): LiveProtocol {
  if (protocol === 'WEBRTC') return 'webrtc';
  if (protocol === 'LL-HLS') return 'llhls';
  return 'hls';
}

function seekVideoToLiveEdge(element: HTMLVideoElement) {
  const ranges = element.seekable;
  if (!ranges.length) return false;

  const liveEdge = ranges.end(ranges.length - 1);
  if (!Number.isFinite(liveEdge) || liveEdge <= 0) return false;

  const target = Math.max(ranges.start(ranges.length - 1), liveEdge - LIVE_EDGE_OFFSET_SECONDS);
  const drift = liveEdge - element.currentTime;

  if (Number.isFinite(drift) && drift > LIVE_EDGE_OFFSET_SECONDS) {
    element.currentTime = target;
    return true;
  }

  return false;
}

function getPlaybackProgress(element: HTMLVideoElement): PlaybackProgress {
  return {
    wallTime: Date.now(),
    mediaTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
  };
}

function createLiveViewSessionId(cameraId: string) {
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `live-${cameraId}-${Date.now().toString(36)}-${randomPart}`;
}

export function LiveStreamPlayer({
  cameraId,
  cameraName,
  className,
  autoPlay = true,
  muted = true,
  showOverlay = true,
  aiEnabled = true,
  liveViewMode = 'selected',
  startDelayMs = 0,
  routeActive = true,
  onStatusChange,
  onGridSourceIsOriginal,
}: LiveStreamPlayerProps) {
  // "Mostrar quadrado no objeto" (tela de IA). Só afeta o DESENHO — a detecção
  // continua rodando e os eventos seguem sendo registrados.
  const mostrarCaixa = useAiPreferencesStore((state) => state.showObjectBox);
  const carregarPrefsDeIa = useAiPreferencesStore((state) => state.carregar);
  useEffect(() => { void carregarPrefsDeIa(); }, [carregarPrefsDeIa]);
  const aiOverlayEnabled = showOverlay && aiEnabled && mostrarCaixa;
  const accessToken = useAuthStore((state) => state.accessToken);
  const authUserId = useAuthStore((state) => state.user?.id ?? 'anonymous');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<HlsController | null>(null);
  const webrtcPcRef = useRef<RTCPeerConnection | null>(null);
  const webrtcSessionUrlRef = useRef<string | null>(null);
  const webrtcStreamRef = useRef<MediaStream | null>(null);
  const webrtcAbortControllerRef = useRef<AbortController | null>(null);
  const webrtcDisconnectTimerRef = useRef<number | null>(null);
  const hasFrameRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const rtmpBackgroundRecoveryRef = useRef(false);
  const activeProtocolRef = useRef<ActiveLiveProtocol | null>(null);
  const primaryProtocolRef = useRef<LiveProtocol>('webrtc');
  const hiddenAtRef = useRef<number | null>(null);
  const routeWasActiveRef = useRef(routeActive);
  const routeResumeTimerRef = useRef<number | null>(null);
  const liveReloadAtRef = useRef(0);
  const preserveFrameOnReloadRef = useRef(false);
  const lastProgressRef = useRef<PlaybackProgress>({ wallTime: Date.now(), mediaTime: 0 });
  const lastRenderedFrameRef = useRef<PlaybackProgress & { presentedFrames: number }>({
    wallTime: Date.now(),
    mediaTime: 0,
    presentedFrames: 0,
  });
  const webrtcInboundRef = useRef<{
    sample: WebrtcInboundSample | null;
    lastProgressAt: number;
    polling: boolean;
    recoveryRequested: boolean;
  }>({
    sample: null,
    lastProgressAt: Date.now(),
    polling: false,
    recoveryRequested: false,
  });
  const blackFrameSinceRef = useRef<number | null>(null);
  const failedProtocolsRef = useRef<Set<LiveProtocol>>(new Set());
  const sourceVideoCodecRef = useRef<string | null>(null);
  const visualCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveViewSessionIdRef = useRef<string>(createLiveViewSessionId(cameraId));
  // viewMode atual lido pelo heartbeat do lease sem recriar a sessão a cada
  // alternância grid/selected (evita stop+start de lease a cada clique na grade).
  const liveViewModeRef = useRef(liveViewMode);
  liveViewModeRef.current = liveViewMode;
  const previousLiveViewModeRef = useRef(liveViewMode);
  // Timer to proactively renew the stream token before it expires (avoids black screen)
  const streamTokenRenewTimerRef = useRef<number | null>(null);
  const mediaAuthTokenRef = useRef<string>('');
  const lastBitrateSampleRef = useRef<{ at: number; bytes: number } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(muted);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [activeProtocol, setActiveProtocol] = useState<ActiveLiveProtocol | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [hasLiveFrame, setHasLiveFrame] = useState(false);
  const relatarPlayer = useRedeStore((s) => s.relatarPlayer);
  const esquecerPlayer = useRedeStore((s) => s.esquecerPlayer);
  const [detections, setDetections] = useState<LiveDetection[]>([]);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [protocolReason, setProtocolReason] = useState<string | null>(null);
  // Aviso VISÍVEL e temporário para o usuário (ex.: "Máxima caiu p/ H.264 — sem HEVC").
  // Diferente do protocolReason (que só sobe pro pai); este aparece na tela e some só.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);
  const [displayFps, setDisplayFps] = useState<number | null>(null);
  const [sourceVideoCodec, setSourceVideoCodec] = useState<string | null>(null);
  const [isTranscodedForBrowser, setIsTranscodedForBrowser] = useState(false);
  // Defesa também no cliente: respostas antigas ainda podem estar no cache do
  // navegador. Conversão de vídeo só existe quando a ORIGEM é HEVC/H.265.
  // H.264 com publisher de áudio continua sendo passthrough de vídeo.
  const showsVideoTranscode = isTranscodedForBrowser
    && videoCodecFamily(sourceVideoCodec) === 'hevc';
  // Custo da conversão, medido no servidor. A etiqueta de codec já mostrava
  // "H265 → H.264", mas sem dizer que isso custa 5× de CPU — o operador não tinha
  // como saber que o navegador dele é a causa, nem que trocar resolve de graça.
  const [transcodeCost, setTranscodeCost] = useState<{ cpuMultiplier?: number; reason?: string; hint?: string } | null>(null);
  const [measuredBitrateKbps, setMeasuredBitrateKbps] = useState<number | null>(null);
  const [liveLatencySeconds, setLiveLatencySeconds] = useState<number | null>(null);
  // Suspende a transmissão quando a aba fica oculta por tempo suficiente, para
  // não gastar CPU de transcode nem banda com quem não está vendo.
  const [suspended, setSuspended] = useState(false);
  // ESCALONAMENTO É COISA DA PRIMEIRA MONTAGEM, NÃO DO CICLO DE VIDA.
  //
  // `startDelayMs` vem de streamStartDelay(indice, total) — muda quando o
  // operador MOVE uma câmera na grade ou troca 3x3 por 4x4. Como era dependência
  // do efeito de conexão, qualquer rearranjo visual fechava e reabria streams que
  // continuaram na tela o tempo todo. A grade inteira piscava por mudança de
  // layout, sem falha nenhuma de câmera ou rede.
  //
  // Numa ref, o valor certo continua disponível no boot (que é quando o
  // escalonamento importa) e deixa de reiniciar vídeo saudável.
  const startDelayMsRef = useRef(startDelayMs);
  startDelayMsRef.current = startDelayMs;
  // Poster que não carregou apenas desaparece. Nunca influencia o transporte.
  const [posterFailed, setPosterFailed] = useState(false);
  const suspendedRef = useRef(false);
  const suspendTimerRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);
  // Deslocamento (pan) do vídeo ampliado, em px. Modelo translate+scale com
  // origem no canto (0 0): permite AMPLIAR no ponto do mouse E ARRASTAR para ver
  // o resto. Refs espelham o estado para os handlers de janela não pegarem
  // valores velhos (o closure do addEventListener congela o estado).
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ mouseX: number; mouseY: number; panX: number; panY: number } | null>(null);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  // Mantém o vídeo dentro do quadro: com origem no canto, o conteúdo ampliado
  // tem largura `z×W`, então o pan válido vai de 0 (borda esquerda/topo) até
  // `-(z-1)×W` (borda direita/baixo). Sem isto, arrastar mostraria fundo preto.
  const clampPan = useCallback((p: { x: number; y: number }, z: number, rect: DOMRect) => ({
    x: Math.min(0, Math.max(-(z - 1) * rect.width, p.x)),
    y: Math.min(0, Math.max(-(z - 1) * rect.height, p.y)),
  }), []);
  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);
  // Câmera única sempre começa na imagem original. Instantâneo é uma escolha
  // temporária do operador para AQUELE atendimento; persistir essa preferência
  // fazia um duplo clique posterior na grade abrir uma câmera esquecida em
  // baixa qualidade.
  const [qualityMode, setQualityMode] = useState<LiveQualityMode>('max');
  // Grade começa sem trilha de áudio: evita uma conversão AAC→Opus por tile.
  // O gesto explícito no ícone de volume troca SOMENTE esta câmera para o
  // perfil com áudio, preservando o último frame durante a renegociação.
  const [gridAudioRequested, setGridAudioRequested] = useState(false);
  const [audioSwitchMessage, setAudioSwitchMessage] = useState<string | null>(null);
  // A grade começa sempre pelo bitstream original do substream. Só muda para o
  // path H.264 depois que este cliente realmente falhar em WebRTC/H.265 (e no
  // HLS/H.265, quando MSE estiver disponível). A detecção declarativa de codec
  // dos navegadores é incompleta; o teste real de reprodução é autoritativo.
  const [gridUsesH264Fallback, setGridUsesH264Fallback] = useState(false);
  const [gridSourceIsOriginal, setGridSourceIsOriginal] = useState(false);
  useEffect(() => {
    setQualityMode('max');
    setGridUsesH264Fallback(false);
    setGridSourceIsOriginal(false);
    setGridAudioRequested(false);
    setAudioSwitchMessage(null);
    retryAttemptRef.current = 0;
    rtmpBackgroundRecoveryRef.current = false;
  }, [cameraId]);
  // RESTAURO TEMPORÁRIO (2026-09-01): a grade HEVC-via-WebRTC (`grid-hevc`)
  // black-screena em navegadores sem decodificação HEVC/WebRTC, e o fallback
  // para H.264 não dispara quando a negociação é CANCELADA (só quando FALHA).
  // Resultado: grade/ronda toda preta. Enquanto o fallback do `grid-hevc` não
  // for confiável, a grade usa o caminho H.264 comprovado ("Instantâneo").
  // Para reativar o HEVC: volte GRID_HEVC_ENABLED para true.
  const GRID_HEVC_ENABLED = false;
  const reusesGridAtMaximum = liveViewMode === 'selected' && qualityMode === 'max' && gridSourceIsOriginal;
  const deliveryMode: LiveDeliveryMode = liveViewMode === 'selected'
    ? (qualityMode === 'max' ? (reusesGridAtMaximum ? 'grid' : 'original') : 'grid-audio')
    : gridAudioRequested
      ? 'grid-audio'
      : (GRID_HEVC_ENABLED && !gridUsesH264Fallback) ? 'grid-hevc' : 'grid';

  const changeQuality = useCallback((next: LiveQualityMode) => {
    // A declaração de codecs do navegador é apenas uma pista: alguns clientes
    // reproduzem HEVC/WebRTC sem anunciá-lo em getCapabilities(). Uma escolha
    // explícita por "Máxima" ganha um teste real; se ele falhar, a própria
    // máquina de estados retorna com segurança ao caminho H.264.
    setQualityMode((current) => {
      if (current === next) return current;
      failedProtocolsRef.current.clear();
      retryAttemptRef.current = 0;
      setRetryMessage(next === 'max' ? 'Abrindo vídeo original da câmera…' : 'Ajustando qualidade…');
      // Mantém o último frame na tela durante a renegociação (sem tela preta).
      if (hasFrameRef.current) preserveFrameOnReloadRef.current = true;
      return next;
    });
  }, [cameraId]);

  const compactLiveOverlay = liveViewMode === 'grid';
  const browserHevcKnown = BROWSER_DECODES_HEVC || hasWebrtcHevcProof();
  const loadingLabel = compactLiveOverlay
    ? 'Conectando…'
    : retryMessage
      ? friendlyLiveText(retryMessage, 'Reconectando à câmera…')
      : 'Aguardando vídeo';

  // A troca de perfil para incluir/remover Opus exige uma renegociação WebRTC.
  // O último frame pode desaparecer por um instante durante a substituição do
  // MediaStream; o aviso evita que isso pareça uma falha da câmera. Há limite
  // para uma anomalia de rede nunca deixar o selo preso na tela.
  useEffect(() => {
    if (!audioSwitchMessage) return;
    const timeout = window.setTimeout(() => setAudioSwitchMessage(null), 15_000);
    return () => window.clearTimeout(timeout);
  }, [audioSwitchMessage]);

  useEffect(() => {
    if (error) setAudioSwitchMessage(null);
  }, [error]);
  const compactErrorLabel = error && TECHNICAL_LIVE_MESSAGE_REGEX.test(error)
    ? 'Reconectando…'
    : 'Sem vídeo';
  const errorIsTechnical = Boolean(error && TECHNICAL_LIVE_MESSAGE_REGEX.test(error));

  const tokenHeaders = useMemo(
    () => (accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined),
    [accessToken],
  );
  // PISCADA EM LOTE A CADA 5 MINUTOS — a causa morava aqui.
  //
  // A sessão é revalidada de 5 em 5 minutos (App.tsx) e isso ROTACIONA o
  // accessToken. Como `accessToken` e `tokenHeaders` eram dependências do efeito
  // de conexão, cada tile via a dependência mudar e REMONTAVA a conexão — as 20
  // câmeras reconectando no mesmo segundo. MEDIDO: quedas em massa às 16:17,
  // 16:22, 16:27, 16:32 e 16:37, sempre com "peer connection closed" (fechamento
  // pelo NAVEGADOR) poucos segundos após a revalidação.
  //
  // Token novo não invalida sessão WebRTC já estabelecida: ele é usado no
  // HANDSHAKE (busca das URLs e POST do WHEP) e depois a mídia flui pelo canal
  // já negociado. Então o valor vai para uma ref — quem precisa lê o atual na
  // hora de usar — e o efeito passa a depender apenas de o token EXISTIR.
  // Login e logout continuam reagindo; rotação não derruba mais nada.
  const tokenHeadersRef = useRef(tokenHeaders);
  tokenHeadersRef.current = tokenHeaders;
  const hasAccessToken = Boolean(accessToken);

  useEffect(() => {
    setIsMuted(muted);
  }, [muted]);

  // Zoom por scroll SÓ na câmera única (1x1). Na grade o scroll não deve
  // sequestrar a rolagem nem dar zoom num tile.
  //
  // O listener fica na JANELA, não no container: por cima do vídeo há o botão
  // "clique para selecionar" (z-15) da página, que NÃO é filho deste container.
  // Um scroll real do usuário atinge esse botão primeiro, e como ele está fora
  // do container, o evento nunca chegava ao zoom — o mouse do usuário não fazia
  // nada (medido no navegador, 10/08/2026). Ouvindo na janela e conferindo se o
  // cursor está SOBRE este player, o overlay deixa de importar.
  useEffect(() => {
    if (liveViewMode !== 'selected') return;
    const dentro = (rect: DOMRect, e: { clientX: number; clientY: number }) =>
      e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;

    const onWheel = (e: WheelEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || !dentro(rect, e)) return;
      e.preventDefault();
      const z0 = zoomRef.current;
      const step = e.deltaY > 0 ? -0.2 : 0.2;
      const z1 = Math.min(4, Math.max(1, parseFloat((z0 + step).toFixed(2))));
      if (z1 === z0) return;
      if (z1 === 1) { resetZoom(); return; }
      // Ponto do cursor DENTRO do container (px). O pan é ajustado para que o que
      // está sob o mouse continue sob o mouse — é isso que faz o zoom "entrar"
      // onde se aponta (translate+scale, origem no canto): pan1 = m − (m−pan0)·z1/z0.
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const p0 = panRef.current;
      const p1 = clampPan(
        { x: mx - (mx - p0.x) * (z1 / z0), y: my - (my - p0.y) * (z1 / z0) },
        z1,
        rect,
      );
      setZoom(z1);
      setPan(p1);
    };

    // ARRASTAR (pan) com o mouse quando ampliado. mousedown na JANELA (o botão
    // de seleção z-15 fica por cima e não é filho do container — mesma razão do
    // wheel); mousemove/up na janela para o arraste continuar mesmo saindo.
    const onMouseDown = (e: MouseEvent) => {
      if (zoomRef.current <= 1 || e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (!dentro(rect, e)) return;
      e.preventDefault();
      dragRef.current = { mouseX: e.clientX, mouseY: e.clientY, panX: panRef.current.x, panY: panRef.current.y };
      setDragging(true);
    };
    const onMouseMove = (e: MouseEvent) => {
      const d = dragRef.current;
      const container = containerRef.current;
      if (!d || !container) return;
      const rect = container.getBoundingClientRect();
      setPan(clampPan(
        { x: d.panX + (e.clientX - d.mouseX), y: d.panY + (e.clientY - d.mouseY) },
        zoomRef.current,
        rect,
      ));
    };
    const onMouseUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(false);
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [liveViewMode, clampPan, resetZoom]);

  // Sair do 1x1 (voltar à grade) ou trocar de câmera zera o zoom: cada tela
  // nasce mostrando o quadro inteiro. Sem isto, o zoom "grudava" ao voltar.
  useEffect(() => {
    resetZoom();
  }, [cameraId, liveViewMode, resetZoom]);

  useEffect(() => {
    failedProtocolsRef.current.clear();
    blackFrameSinceRef.current = null;
    mediaAuthTokenRef.current = '';
    lastBitrateSampleRef.current = null;
    webrtcInboundRef.current = {
      sample: null,
      lastProgressAt: Date.now(),
      polling: false,
      recoveryRequested: false,
    };
    setProtocolReason(null);
    setSourceVideoCodec(null);
    sourceVideoCodecRef.current = null;
    setIsTranscodedForBrowser(false);
    setMeasuredBitrateKbps(null);
    setLiveLatencySeconds(null);
    liveViewSessionIdRef.current = createLiveViewSessionId(cameraId);
  }, [cameraId]);

  useEffect(() => {
    onStatusChange?.({
      activeProtocol,
      state: error ? 'error' : isLoading ? 'loading' : protocolReason ? 'fallback' : 'playing',
      reason: error ?? protocolReason ?? retryMessage,
    });
  }, [activeProtocol, error, isLoading, onStatusChange, protocolReason, retryMessage]);

  // ── RELATO PARA O DIAGNÓSTICO DE REDE ─────────────────────────────────────
  // O aviso "sua conexão está instável" depende de distinguir DOIS fracassos
  // que na tela parecem iguais (quadro preto):
  //   • a sessão nem abriu  → o servidor recusou/não respondeu → problema DELE;
  //   • a sessão abriu e a imagem não vem → caminho do vídeo → última milha.
  // Sem esta distinção, o aviso viraria chute — e chutar "é a sua internet"
  // durante uma falha nossa é pior que não avisar. Ver lib/qualidade-de-rede.ts.
  useEffect(() => {
    const chave = `${cameraId}:${liveViewMode}`;
    relatarPlayer(chave, classificarFalhaDePlayer(error, hasLiveFrame, isLoading));
    return () => esquecerPlayer(chave);
  }, [cameraId, liveViewMode, error, hasLiveFrame, isLoading, relatarPlayer, esquecerPlayer]);

  const requestFreshLiveBoot = useCallback((
    message = 'Atualizando transmissão ao vivo...',
    preserveExistingFrame = true,
    bypassDebounce = false,
  ) => {
    const now = Date.now();
    if (!bypassDebounce && now - liveReloadAtRef.current < LIVE_RECONNECT_DEBOUNCE_MS) return;

    const alreadyHadFrame = hasFrameRef.current;
    liveReloadAtRef.current = now;
    setRetryMessage(message);
    setError(null);
    if (!alreadyHadFrame || !preserveExistingFrame) {
      setActiveProtocol(null);
      activeProtocolRef.current = null;
      setIsLoading(true);
      setHasLiveFrame(false);
      hasFrameRef.current = false;
    } else {
      preserveFrameOnReloadRef.current = true;
      setIsLoading(false);
    }
    setReloadNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    const wasActive = routeWasActiveRef.current;
    routeWasActiveRef.current = routeActive;

    if (routeResumeTimerRef.current != null) {
      window.clearTimeout(routeResumeTimerRef.current);
      routeResumeTimerRef.current = null;
    }
    if (!routeActive || wasActive) return;

    // Navegar dentro da aplicação não muda document.visibilityState. A árvore
    // de /live fica retida por alguns segundos para preservar o WebRTC, mas o
    // Chromium pode parar de compor o <video> enquanto o ancestral está
    // `hidden`. Antes, ao voltar, o selo continuava exibindo WEBRTC/FPS embora
    // o quadro permanecesse preto até um reload completo.
    const element = videoRef.current;
    const renderedBefore = lastRenderedFrameRef.current.presentedFrames;
    if (autoPlay && element) void element.play().catch(() => undefined);

    routeResumeTimerRef.current = window.setTimeout(() => {
      routeResumeTimerRef.current = null;
      const current = videoRef.current;
      if (!current || !routeWasActiveRef.current || document.hidden) return;

      const renderedAfter = lastRenderedFrameRef.current.presentedFrames;
      const resumedRendering = renderedAfter > renderedBefore
        && current.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      if (resumedRendering) return;

      // Sessão retida sem novo quadro: refaz apenas este transporte, como o
      // botão Recarregar fazia, sem recarregar a aplicação nem perder a grade.
      requestFreshLiveBoot('Retomando câmera em tempo real…', false, true);
    }, 700);

    return () => {
      if (routeResumeTimerRef.current != null) {
        window.clearTimeout(routeResumeTimerRef.current);
        routeResumeTimerRef.current = null;
      }
    };
  }, [autoPlay, requestFreshLiveBoot, routeActive]);

  useEffect(() => {
    if (previousLiveViewModeRef.current === liveViewMode) return;
    previousLiveViewModeRef.current = liveViewMode;
    failedProtocolsRef.current.clear();
    // Grade → câmera única (inclusive duplo clique): reinicia em Máxima.
    // A escolha por Instantâneo continua existindo, mas apenas até o operador
    // voltar à grade; ela não pode virar uma preferência esquecida por câmera.
    if (liveViewMode === 'selected') setQualityMode('max');
    if (liveViewMode === 'grid') setGridUsesH264Fallback(false);
    // O reboot do stream acontece pelo próprio effect de boot (deliveryMode nas
    // dependências). Aqui só preparamos a transição: mensagem amigável e
    // preservação do último frame — sem bump de nonce, senão o boot rodaria DUAS
    // vezes na troca grade↔individual (piscada).
    setRetryMessage(liveViewMode === 'selected' ? 'Abrindo câmera individual…' : 'Ajustando para a grade…');
    setError(null);
    if (hasFrameRef.current) {
      preserveFrameOnReloadRef.current = true;
      setIsLoading(false);
    }
  }, [liveViewMode]);

  // ── VIVACIDADE É QUADRO AVANÇANDO, NÃO BRILHO ─────────────────────────────
  //
  // A checagem de imagem preta media a coisa errada. Cena legitimamente escura —
  // madrugada, lente coberta, transição do infravermelho, ambiente apagado — é
  // vídeo PERFEITO, e era tratada como falha: o quadro nunca era aceito, o
  // protocolo estourava o prazo e caía para o próximo, gastando ~30s em cascata
  // com mídia chegando o tempo todo.
  //
  // O sinal honesto é o contador de quadros decodificados do próprio elemento.
  // Se ele avança, o transporte está vivo, seja a cena branca ou preta.
  const decodedFramesRef = useRef<{ count: number; at: number } | null>(null);
  const framesAreProgressing = useCallback((element: HTMLVideoElement) => {
    const quality = (element as any).getVideoPlaybackQuality?.();
    const count = Number(
      quality?.totalVideoFrames ?? (element as any).webkitDecodedFrameCount ?? NaN,
    );
    // Navegador que não expõe o contador não pode ser punido por isso: sem sinal,
    // assume-se vivo (o prazo de conexão continua sendo a rede de proteção).
    if (!Number.isFinite(count)) return true;
    const anterior = decodedFramesRef.current;
    decodedFramesRef.current = { count, at: Date.now() };
    if (!anterior) return false; // primeira leitura: ainda não dá para comparar
    return count > anterior.count;
  }, []);

  const isLikelyBlackFrame = useCallback((element: HTMLVideoElement) => {
    if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || element.videoWidth <= 0 || element.videoHeight <= 0) {
      return false;
    }
    try {
      const canvas = visualCanvasRef.current ?? document.createElement('canvas');
      visualCanvasRef.current = canvas;
      canvas.width = 16;
      canvas.height = 9;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      let brightest = 0;
      const samples = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        const value = ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3;
        sum += value;
        brightest = Math.max(brightest, value);
      }
      return sum / samples < 3 && brightest < 12;
    } catch {
      return false;
    }
  }, []);

  const getFastRetryDelay = useCallback(() => {
    const attempt = retryAttemptRef.current;
    const delayMs = Math.min(LIVE_FAST_RETRY_MAX_MS, LIVE_FAST_RETRY_BASE_MS * Math.max(1, 2 ** attempt));
    retryAttemptRef.current = attempt + 1;
    return delayMs;
  }, []);

  const scheduleFastRetry = useCallback((message: string, preserveExistingFrame = true) => {
    if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
    const delayMs = getFastRetryDelay();
    const alreadyHadFrame = hasFrameRef.current && preserveExistingFrame;
    setError(null);
    setRetryMessage(message);
    if (!alreadyHadFrame) {
      setActiveProtocol(null);
      activeProtocolRef.current = null;
      setIsLoading(true);
      setHasLiveFrame(false);
      hasFrameRef.current = false;
    } else {
      preserveFrameOnReloadRef.current = true;
      setIsLoading(false);
    }
    retryTimerRef.current = window.setTimeout(() => {
      failedProtocolsRef.current.clear();
      retryTimerRef.current = null;
      setReloadNonce((value) => value + 1);
    }, delayMs);
  }, [getFastRetryDelay]);

  const reportLiveFailure = useCallback((
    protocol: LiveProtocol,
    stage: 'startup' | 'startup_retry' | 'runtime',
    reason: string,
    state?: string | null,
  ) => {
    if (!tokenHeadersRef.current) return;
    void axios.post(`${API_URL}/camera-stream/${cameraId}/live-failure`, {
      protocol,
      stage,
      reason,
      state: state ?? activeProtocolRef.current ?? 'not-playing',
    }, { headers: tokenHeadersRef.current, timeout: 5000 }).catch(() => undefined);
  }, [cameraId]);

  const failActiveProtocol = useCallback((reason: string) => {
    const active = activeProtocolRef.current;
    if (active) {
      reportLiveFailure(normalizeActiveProtocol(active), 'runtime', reason, active);
      failedProtocolsRef.current.add(normalizeActiveProtocol(active));
      const transitionReason = `${active} falhou: ${reason}. Alternando para o próximo protocolo.`;
      setProtocolReason(transitionReason);
      const actualCodec = sourceVideoCodecRef.current;
      const candidates = buildLiveProtocolOrder({
        deliveryMode,
        sourceCodec: actualCodec,
        mseDecodesHevc: MSE_DECODES_HEVC,
      });
      const exhausted = candidates.every((protocol) => failedProtocolsRef.current.has(protocol));
      if (exhausted) {
        if (shouldUseGridH264Fallback(deliveryMode, actualCodec)) {
          failedProtocolsRef.current.clear();
          setProtocolReason('A fonte original não foi reproduzida neste cliente; ativando a contingência H.264.');
          setGridUsesH264Fallback(true);
          return;
        }
        if (deliveryMode === 'original' && videoCodecFamily(actualCodec) === 'hevc') {
          failedProtocolsRef.current.clear();
          setQualityMode('instant');
          setProtocolReason('O teste real de H.265 falhou; usando a contingência H.264.');
          setNotice('O teste real de H.265 falhou neste navegador. Exibindo em H.264.');
          return;
        }
        scheduleFastRetry('Reconectando transmissão...', true);
        return;
      }
      requestFreshLiveBoot('Reconectando transmissão...', true);
      return;
    }
    scheduleFastRetry('Reconectando transmissão...', true);
  }, [cameraId, deliveryMode, reportLiveFailure, requestFreshLiveBoot, scheduleFastRetry]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !tokenHeadersRef.current) return;

    let cancelled = false;
    let noFrameTimeout: number | null = null;
    let bootDelayTimeout: number | null = null;

    const clearRetryTimer = () => {
      if (retryTimerRef.current == null) return;
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    };

    const markHealthy = (protocol: ActiveLiveProtocol) => {
      retryAttemptRef.current = 0;
      rtmpBackgroundRecoveryRef.current = false;
      setRetryMessage(null);
      setAudioSwitchMessage(null);
      setError(null);
      setActiveProtocol(protocol);
      activeProtocolRef.current = protocol;
      lastProgressRef.current = getPlaybackProgress(element);
      lastRenderedFrameRef.current = {
        wallTime: Date.now(),
        mediaTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
        presentedFrames: lastRenderedFrameRef.current.presentedFrames,
      };
      hasFrameRef.current = true;
      setIsLoading(false);
      setHasLiveFrame(true);
      const actualCodec = sourceVideoCodecRef.current;
      storeProtocol(cameraId, protocol, deliveryMode, actualCodec);
      if (normalizeActiveProtocol(protocol) === primaryProtocolRef.current) {
        setProtocolReason(null);
      }
      if (protocol === 'WEBRTC' && videoCodecFamily(actualCodec) === 'hevc') {
        // Prova observada vence uma declaração incompleta do navegador. Ela é
        // local a este navegador e expira, portanto não contamina outros clientes.
        storeWebrtcHevcProof();
      }
    };

    const scheduleReconnect = (message: string) => {
      if (cancelled) return;
      clearRetryTimer();
      const delayMs = getFastRetryDelay();
      const alreadyHadFrame = hasFrameRef.current;
      setError(null);
      const warmupMessage = /Nenhum protocolo de live conseguiu iniciar|Aguardando vídeo|Aguardando transmissão RTMP/i.test(message);
      setRetryMessage(warmupMessage
        ? 'Aguardando vídeo da câmera'
        : `${message} Reconectando...`);
      if (!alreadyHadFrame) {
        setActiveProtocol(null);
        activeProtocolRef.current = null;
        setIsLoading(true);
        setHasLiveFrame(false);
      } else {
        preserveFrameOnReloadRef.current = true;
        setIsLoading(false);
      }
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        setReloadNonce((value) => value + 1);
      }, delayMs);
    };

    const scheduleRtmpBackgroundRecovery = (message: string) => {
      if (cancelled) return;
      clearRetryTimer();
      rtmpBackgroundRecoveryRef.current = true;
      setError(message);
      setRetryMessage(null);
      setIsLoading(false);
      setActiveProtocol(null);
      activeProtocolRef.current = null;
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        failedProtocolsRef.current.clear();
        streamUrlsCache.clear(`stream-urls:${authUserId}:${cameraId}:${deliveryMode}`);
        setReloadNonce((value) => value + 1);
      }, RTMP_SOURCE_BACKGROUND_RETRY_MS);
    };

    const boot = async () => {
      const alreadyHadFrame = hasFrameRef.current;
      const backgroundRtmpRecovery = rtmpBackgroundRecoveryRef.current;
      if (!backgroundRtmpRecovery) {
        setIsLoading(!alreadyHadFrame);
        setError(null);
      }
      if (!alreadyHadFrame && !backgroundRtmpRecovery) {
        setActiveProtocol(null);
        activeProtocolRef.current = null;
        setHasLiveFrame(false);
        hasFrameRef.current = false;
      }

      try {
        // Use cache to deduplicate concurrent requests for the same camera
        // This prevents overwhelming the backend when multiple cameras load simultaneously.
        // A chave usa câmera + modo de visualização. Grid e câmera individual
        // precisam perfis diferentes, mas ainda evitamos incluir o JWT para não
        // deixar entradas órfãs no cache.
        const cacheKey = `stream-urls:${authUserId}:${cameraId}:${deliveryMode}`;
        const data = await streamUrlsCache.getOrFetch(
          cacheKey,
          () => axios.get<{
            preferredLiveProtocol?: 'auto' | 'flv' | 'hls' | 'llhls' | 'webrtc' | 'mjpeg' | null;
            detectedVideoCodec?: string | null;
            sourceVideoCodec?: string | null;
            deliveryMode?: LiveDeliveryMode;
            deliveryTarget?: Record<string, unknown> | null;
            smartLive?: {
              enabled?: boolean;
              recommendedProtocol?: LiveProtocol;
              protocolOrder?: LiveProtocol[];
            } | null;
            liveDiagnostics?: LiveDiagnostics | null;
            protocols?: {
              posterUrl?: string | null;
              hlsUrl?: string | null;
              webrtcUrl?: string | null;
              whepUrl?: string | null;
            };
            streamToken?: string;
            streamTokenExpiresAt?: string | null;
          }>(
            `${API_URL}/camera-stream/${cameraId}/urls`,
            {
              headers: tokenHeadersRef.current,
              params: { viewMode: deliveryMode },
              // PRAZO PRÓPRIO, obrigatório.
              //
              // Sem ele, a única barreira era o nginx a 300s. Pior: a promessa
              // pendente fica registrada como "em voo", e TODA nova montagem da
              // mesma câmera reaproveita a MESMA requisição travada — um tile
              // preso prendia os demais, com "Conectando" por minutos e nenhuma
              // tentativa nova. Estourar rápido e repetir é sempre melhor que
              // esperar para sempre.
              timeout: LIVE_URLS_TIMEOUT_MS,
            },
          ).then(res => res.data),
          STREAM_URL_CACHE_TTL_MS,
        );

        if (cancelled) return;

        const streamToken = data?.streamToken ?? '';
        const rawPosterUrl = data?.protocols?.posterUrl ?? `${API_URL}/camera-stream/${cameraId}/poster`;
        const hlsUrl = data?.protocols?.hlsUrl ?? null;
        const whepUrl =
          data?.protocols?.whepUrl
          ?? (data?.protocols?.webrtcUrl ? `${data.protocols.webrtcUrl.replace(/\/+$/, '')}/whep` : null);
        const preferredLiveProtocol = data?.preferredLiveProtocol ?? 'webrtc';
        const sourceCodec = data?.sourceVideoCodec ?? data?.detectedVideoCodec;
        if (deliveryMode === 'grid') {
          const isOriginal = data?.deliveryTarget?.sourceIsOriginal === true;
          setGridSourceIsOriginal(isOriginal);
          onGridSourceIsOriginal?.(isOriginal);
        }
        const liveDiagnostics = data?.liveDiagnostics ?? null;
        mediaAuthTokenRef.current = streamToken;
        sourceVideoCodecRef.current = sourceCodec ?? null;
        setSourceVideoCodec(sourceCodec ?? null);
        setIsTranscodedForBrowser(Boolean(liveDiagnostics?.liveTranscodedForBrowser));
        setTranscodeCost((liveDiagnostics as { transcodeCost?: typeof transcodeCost } | null)?.transcodeCost ?? null);
        const orderedProtocols = buildLiveProtocolOrder({
          deliveryMode,
          sourceCodec,
          preferred: preferredLiveProtocol,
          smartOrder: data?.smartLive?.protocolOrder ?? null,
          learned: getStoredProtocol(cameraId, deliveryMode, sourceCodec),
          mseDecodesHevc: MSE_DECODES_HEVC,
        });
        primaryProtocolRef.current = orderedProtocols[0] ?? 'webrtc';
        let protocolOrder: LiveProtocol[] = orderedProtocols.filter((protocol) => !failedProtocolsRef.current.has(protocol));
        if (!protocolOrder.length) {
          if (shouldUseGridH264Fallback(deliveryMode, sourceCodec)) {
            failedProtocolsRef.current.clear();
            streamUrlsCache.clear(cacheKey);
            setProtocolReason('A fonte original não foi reproduzida neste cliente; ativando a contingência H.264.');
            setGridUsesH264Fallback(true);
            return;
          }
          if (deliveryMode === 'original' && videoCodecFamily(sourceCodec) === 'hevc') {
            setQualityMode('instant');
            failedProtocolsRef.current.clear();
            setProtocolReason('Este navegador não decodifica H.265 — usando o modo Instantâneo (H.264).');
            setNotice('O teste real de H.265 falhou neste navegador. Exibindo em H.264.');
            return;
          }
          failedProtocolsRef.current.clear();
          protocolOrder = orderedProtocols;
          setProtocolReason('Reconectando transmissão.');
        }

        if (rawPosterUrl && streamToken) {
          const separator = rawPosterUrl.includes('?') ? '&' : '?';
          setPosterUrl(`${rawPosterUrl}${separator}token=${encodeURIComponent(streamToken)}&v=${Date.now()}`);
        }

        if (!streamToken) {
          throw new Error('Token de stream inválido retornado pela API.');
        }

        if (streamTokenRenewTimerRef.current != null) {
          window.clearTimeout(streamTokenRenewTimerRef.current);
          streamTokenRenewTimerRef.current = null;
        }
        const renewMediaToken = async () => {
          try {
            const response = await axios.post<{ streamToken: string; expiresAt?: string | null }>(
              `${API_URL}/camera-stream/${cameraId}/token`,
              {},
              { headers: tokenHeadersRef.current },
            );
            if (cancelled) return;
            mediaAuthTokenRef.current = response.data.streamToken;
            if (rawPosterUrl && response.data.streamToken) {
              const separator = rawPosterUrl.includes('?') ? '&' : '?';
              setPosterUrl(`${rawPosterUrl}${separator}token=${encodeURIComponent(response.data.streamToken)}&v=${Date.now()}`);
            }
            scheduleMediaTokenRenewal(response.data.expiresAt ?? null);
          } catch {
            if (!cancelled) {
              streamTokenRenewTimerRef.current = window.setTimeout(() => {
                void renewMediaToken();
              }, 30_000);
            }
          }
        };
        const scheduleMediaTokenRenewal = (expiresAt?: string | null) => {
          if (streamTokenRenewTimerRef.current != null) {
            window.clearTimeout(streamTokenRenewTimerRef.current);
          }
          const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
          const delayMs = Number.isFinite(expiresAtMs)
            ? Math.max(30_000, expiresAtMs - Date.now() - 60_000)
            : 4 * 60_000;
          streamTokenRenewTimerRef.current = window.setTimeout(() => {
            void renewMediaToken();
          }, delayMs);
        };
        scheduleMediaTokenRenewal(data?.streamTokenExpiresAt ?? null);

        const cleanupHls = () => {
          if (!hlsRef.current) return;
          try {
            hlsRef.current.destroy();
          } catch {
          }
          hlsRef.current = null;
        };

        const abortWebrtcNegotiation = () => {
          if (!webrtcAbortControllerRef.current) return;
          try {
            webrtcAbortControllerRef.current.abort();
          } catch {
          }
          webrtcAbortControllerRef.current = null;
        };

        const clearWebrtcDisconnectTimer = () => {
          if (webrtcDisconnectTimerRef.current == null) return;
          window.clearTimeout(webrtcDisconnectTimerRef.current);
          webrtcDisconnectTimerRef.current = null;
        };

        const cleanupWebrtc = async (preserveVideo = false) => {
          abortWebrtcNegotiation();
          clearWebrtcDisconnectTimer();
          if (webrtcPcRef.current) {
            try {
              webrtcPcRef.current.ontrack = null;
              webrtcPcRef.current.onconnectionstatechange = null;
              webrtcPcRef.current.oniceconnectionstatechange = null;
              webrtcPcRef.current.close();
            } catch {
            }
            webrtcPcRef.current = null;
          }
          if (webrtcStreamRef.current) {
            try {
              for (const track of webrtcStreamRef.current.getTracks()) {
                track.stop();
              }
            } catch {
            }
            webrtcStreamRef.current = null;
          }
          // Clear srcObject so HLS can take control — per the HTML media spec,
          // srcObject takes strict priority over src.  If left non-null,
          // hls.js's MediaSource object URL assigned via element.src is silently
          // ignored and the video element never renders HLS content.
          // Skipped when reconnecting WebRTC-to-WebRTC so the last decoded frame
          // stays visible during reconnect instead of flashing black.
          if (!preserveVideo) {
            try {
              element.srcObject = null;
              element.removeAttribute('src');
              element.load();
            } catch {
            }
          }
          if (webrtcSessionUrlRef.current) {
            // ENCERRAR A SESSÃO É CORTESIA, NÃO PRÉ-REQUISITO.
            //
            // Aguardar este DELETE sem teto atrasa a PRÓXIMA conexão pelo tempo
            // que o servidor levar para responder — e o nginx só corta o WHEP em
            // 3600s. O operador ficava vendo "Conectando" por causa de uma
            // despedida. Com teto curto a limpeza acontece quase sempre; quando
            // não acontece, a sessão órfã morre sozinha do lado do servidor.
            const sessao = webrtcSessionUrlRef.current;
            webrtcSessionUrlRef.current = null;
            const abortar = new AbortController();
            const corte = window.setTimeout(() => abortar.abort(), WHEP_DELETE_TIMEOUT_MS);
            try {
              await fetch(sessao, {
                method: 'DELETE',
                mode: 'cors',
                headers: { Authorization: `Bearer ${mediaAuthTokenRef.current}` },
                signal: abortar.signal,
              });
            } catch {
            } finally {
              window.clearTimeout(corte);
            }
          }
        };

        const waitForVisibleFrame = (protocol: ActiveLiveProtocol, timeoutMs: number) => new Promise<void>((resolve, reject) => {
          let interval: number | null = null;
          let blackFrameObserved = false;
          let done = false;
          const finish = (error?: Error) => {
            if (done) return;
            done = true;
            if (interval != null) window.clearInterval(interval);
            window.clearTimeout(timeout);
            if (error) reject(error);
            else resolve();
          };
          const check = () => {
            if (cancelled) {
              finish(new Error('Inicialização cancelada.'));
              return;
            }
            if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || element.videoWidth <= 0 || element.videoHeight <= 0) {
              return;
            }
            if (isLikelyBlackFrame(element)) {
              blackFrameObserved = true;
              // Preto SÓ segura enquanto os quadros NÃO avançam. Câmera em cena
              // escura entrega quadros normalmente e precisa ser aceita — antes
              // ela estourava o prazo e caía de protocolo sem falha nenhuma.
              if (!framesAreProgressing(element)) return;
            }
            finish();
          };
          const timeout = window.setTimeout(() => {
            finish(new Error(blackFrameObserved
              ? `${protocol} conectou, mas entregou apenas imagem preta.`
              : `${protocol} não entregou vídeo válido dentro do tempo limite.`));
          }, timeoutMs);
          interval = window.setInterval(check, 200);
          check();
        });

        const waitIceGatheringComplete = (pc: RTCPeerConnection, timeoutMs = 2500) => {
          return new Promise<void>((resolve) => {
            if (pc.iceGatheringState === 'complete') {
              resolve();
              return;
            }
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              window.clearTimeout(timeout);
              pc.removeEventListener('icegatheringstatechange', onStateChange);
              resolve();
            };
            const onStateChange = () => {
              if (pc.iceGatheringState === 'complete') {
                finish();
              }
            };
            const timeout = window.setTimeout(finish, timeoutMs);
            pc.addEventListener('icegatheringstatechange', onStateChange);
          });
        };

        const startWebrtc = async (whepUrl: string) => {
          cleanupHls();
          // Pass preserveVideo=true when a live frame is already visible so the
          // last decoded frame stays on screen while the new connection negotiates.
          const preserveVideoOnReconnect = preserveFrameOnReloadRef.current && hasFrameRef.current;
          await cleanupWebrtc(preserveVideoOnReconnect);

          if (typeof RTCPeerConnection === 'undefined') {
            throw new Error('Navegador sem suporte WebRTC.');
          }

          if (!preserveVideoOnReconnect) {
            element.removeAttribute('src');
            element.srcObject = null;
            element.load();
          }

          // Segunda barreira contra sessão órfã: se por qualquer caminho ainda
          // houver um `pc` na ref, ele é fechado ANTES de ser substituído.
          // Perder a referência sem fechar deixa a conexão viva no navegador e
          // o leitor vivo no servidor — foi assim que um tile acumulou três
          // sessões da mesma câmera.
          if (webrtcPcRef.current) {
            try { webrtcPcRef.current.close(); } catch { /* já encerrado */ }
          }
          // WHEP não embute o TURN no SDP: ele o anuncia no cabeçalho Link de
          // uma requisição OPTIONS. Na infraestrutura antiga o candidato
          // público direto escondia essa omissão. Atrás da Gateway/NAT, criar
          // o peer sem consultar o Link deixava apenas 10.10.0.x:8189 —
          // inalcançável pelo navegador — e TODA a grade caía para HLS.
          const abortController = new AbortController();
          webrtcAbortControllerRef.current = abortController;
          const mediaToken = mediaAuthTokenRef.current;
          const iceServers = await discoverWhepIceServers(
            whepUrl,
            mediaToken ? `Bearer ${mediaToken}` : null,
            abortController.signal,
          );
          if (cancelled || abortController.signal.aborted) {
            throw new Error('Inicialização WebRTC cancelada.');
          }

          const pc = new RTCPeerConnection({
            iceServers,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
          });
          webrtcPcRef.current = pc;
          webrtcInboundRef.current = {
            sample: null,
            lastProgressAt: Date.now(),
            polling: false,
            recoveryRequested: false,
          };

          pc.addTransceiver('video', { direction: 'recvonly' });
          pc.addTransceiver('audio', { direction: 'recvonly' });
          await new Promise<void>((resolve, reject) => {
            let videoTrackReceived = false;
            let visibleFrameReceived = false;
            let settled = false;
            let whepTimeout: number | null = null;
            // Poll do primeiro frame visível, sem prazo próprio: o startupTimeout
            // abaixo é o único deadline da inicialização (antes havia dois timers de
            // 8s sobrepostos, com mensagens concorrentes e até ~16s de espera real).
            let visibleFramePoll: number | null = null;
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(startupTimeout);
              if (visibleFramePoll != null) {
                window.clearInterval(visibleFramePoll);
                visibleFramePoll = null;
              }
              if (whepTimeout != null) {
                window.clearTimeout(whepTimeout);
                whepTimeout = null;
              }
              if (webrtcAbortControllerRef.current === abortController) {
                webrtcAbortControllerRef.current = null;
              }
              if (error) reject(error);
              else resolve();
            };
            let coldStartExtended = false;
            let startupTimeout = window.setTimeout(() => {
              abortController.abort();
              finish(new Error(videoTrackReceived
                ? 'WebRTC conectou, mas não entregou imagem (vídeo preto ou sem frames) dentro do tempo limite.'
                : 'WebRTC não conectou ou não entregou track de vídeo dentro do tempo limite.'));
            }, WEBRTC_FIRST_FRAME_TIMEOUT_MS);
            // Conexão WebRTC pronta, mas sem frame ainda → publisher (FFmpeg) em cold
            // start. Em vez de estourar em 8s e ir para o próximo protocolo, estende o
            // prazo do primeiro frame UMA vez para o publisher esquentar no mesmo WebRTC.
            const extendDeadlineForColdStart = () => {
              if (coldStartExtended || settled || visibleFrameReceived) return;
              coldStartExtended = true;
              window.clearTimeout(startupTimeout);
              startupTimeout = window.setTimeout(() => {
                abortController.abort();
                finish(new Error('WebRTC conectou, mas o stream demorou demais para entregar o primeiro frame (cold start do FFmpeg).'));
              }, WEBRTC_COLD_START_FRAME_TIMEOUT_MS);
            };
            const failOrRetryWebrtc = (reason: string, _transient: boolean) => {
              if (cancelled || webrtcPcRef.current !== pc) return;
              if (activeProtocolRef.current === 'WEBRTC' && hasFrameRef.current) {
                // Uma sessão que JÁ mostrou imagem provou compatibilidade. ICE
                // perdido ou peer failed pede outro WebRTC, não HLS. Se o novo
                // startup também falhar, a máquina de estados aplica o fallback.
                reportLiveFailure('webrtc', 'runtime', reason, 'WEBRTC');
                requestFreshLiveBoot(`${reason}. Retomando WebRTC...`, true);
                return;
              }
              finish(new Error('Stream indisponível via WebRTC.'));
            };
            const scheduleDisconnectRecovery = (reason: string) => {
              if (webrtcDisconnectTimerRef.current != null) return;
              webrtcDisconnectTimerRef.current = window.setTimeout(() => {
                webrtcDisconnectTimerRef.current = null;
                if (cancelled || webrtcPcRef.current !== pc) return;
                if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                  return;
                }
                failOrRetryWebrtc(reason, true);
              }, WEBRTC_DISCONNECT_GRACE_MS);
            };

            pc.ontrack = (event) => {
              if (cancelled || webrtcPcRef.current !== pc) return;
              const stream = event.streams[0] ?? (() => {
                const fallback = webrtcStreamRef.current ?? new MediaStream();
                fallback.addTrack(event.track);
                return fallback;
              })();
              webrtcStreamRef.current = stream;
              if (element.srcObject !== stream) {
                element.srcObject = stream;
              }
              if (autoPlay) void element.play().catch(() => {});
              if (event.track.kind !== 'video') return;
              videoTrackReceived = true;
              clearWebrtcDisconnectTimer();
              // Espera um frame visível (não preto). Sem timer próprio: se não chegar,
              // o startupTimeout dispara com a mensagem de "conectou, mas sem imagem".
              const checkVisibleFrame = () => {
                if (cancelled || webrtcPcRef.current !== pc) {
                  finish(new Error('Inicialização WebRTC cancelada.'));
                  return;
                }
                if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || element.videoWidth <= 0 || element.videoHeight <= 0) {
                  return;
                }
                // Idem ao caminho comum: preto só adia enquanto não há quadro novo.
                if (isLikelyBlackFrame(element) && !framesAreProgressing(element)) return;
                visibleFrameReceived = true;
                markHealthy('WEBRTC');
                finish();
              };
              visibleFramePoll = window.setInterval(checkVisibleFrame, 200);
              checkVisibleFrame();
            };

            pc.onconnectionstatechange = () => {
              if (cancelled || webrtcPcRef.current !== pc) return;
              if (pc.connectionState === 'connected') {
                clearWebrtcDisconnectTimer();
                if (videoTrackReceived && visibleFrameReceived) {
                  markHealthy('WEBRTC');
                } else {
                  // Transporte pronto, mas ainda sem frame visível: provável cold
                  // start do FFmpeg do path. Espera o publisher esquentar.
                  extendDeadlineForColdStart();
                }
                return;
              }
              if (pc.connectionState === 'disconnected') {
                scheduleDisconnectRecovery('WebRTC desconectou temporariamente');
                return;
              }
              if (pc.connectionState === 'failed') {
                clearWebrtcDisconnectTimer();
                failOrRetryWebrtc('conexão WebRTC falhou', false);
                return;
              }
              if (pc.connectionState === 'closed') {
                clearWebrtcDisconnectTimer();
              }
            };

            pc.oniceconnectionstatechange = () => {
              if (cancelled || webrtcPcRef.current !== pc) return;
              if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                clearWebrtcDisconnectTimer();
                if (visibleFrameReceived) {
                  markHealthy('WEBRTC');
                } else {
                  // ICE pronto, mas sem frame ainda: dá tempo para o cold start do
                  // publisher em vez de cair para HLS + backoff.
                  extendDeadlineForColdStart();
                }
                return;
              }
              if (pc.iceConnectionState === 'disconnected') {
                scheduleDisconnectRecovery('ICE WebRTC desconectou temporariamente');
                return;
              }
              if (pc.iceConnectionState === 'failed') {
                clearWebrtcDisconnectTimer();
                failOrRetryWebrtc('ICE WebRTC falhou', false);
              }
            };

            void (async () => {
              try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await waitIceGatheringComplete(pc);
                if (cancelled || webrtcPcRef.current !== pc) {
                  throw new Error('Inicialização WebRTC cancelada.');
                }

                const localSdp = pc.localDescription?.sdp;
                if (!localSdp) {
                  throw new Error('Falha ao gerar SDP local do WebRTC.');
                }

                whepTimeout = window.setTimeout(() => {
                  abortController.abort();
                }, WEBRTC_WHEP_NEGOTIATION_TIMEOUT_MS);
                const response = await fetch(whepUrl, {
                  method: 'POST',
                  mode: 'cors',
                  headers: {
                    'Content-Type': 'application/sdp',
                    Authorization: `Bearer ${mediaAuthTokenRef.current}`,
                  },
                  body: localSdp,
                  signal: abortController.signal,
                });
                if (whepTimeout != null) {
                  window.clearTimeout(whepTimeout);
                  whepTimeout = null;
                }

                if (!response.ok) {
                  throw new Error(`Falha ao conectar WebRTC (${response.status}).`);
                }

                // VAZAMENTO DE SESSÃO (medido em produção): um tile chegou a ter
                // TRÊS sessões WebRTC vivas para a MESMA câmera. Cada uma baixa e
                // decodifica o mesmo vídeo, competindo entre si — o MediaMTX
                // registrava "reader is too slow, discarding N frames" e o
                // operador via fps baixo e travamento, com o SERVIDOR ocioso.
                //
                // A causa: a URL da sessão ia direto para uma ref COMPARTILHADA
                // entre tentativas. Quando esta tentativa já tinha sido
                // superada (timeout → retry criou outro `pc`), ela sobrescrevia
                // a URL da tentativa nova e o `pc` antigo ficava sem dono: nunca
                // fechado, sessão nunca deletada, leitor eterno no servidor.
                //
                // Agora a URL é LOCAL da tentativa. Só vira a oficial se esta
                // tentativa ainda for a corrente; caso contrário ela mesma se
                // encerra — fecha o `pc` e apaga a sessão no servidor.
                const location = response.headers.get('location');
                const sessionUrl = location ? new URL(location, whepUrl).toString() : null;
                const superada = cancelled || webrtcPcRef.current !== pc || abortController.signal.aborted;
                if (superada) {
                  try { pc.close(); } catch { /* já encerrado */ }
                  if (sessionUrl) {
                    void fetch(sessionUrl, {
                      method: 'DELETE',
                      mode: 'cors',
                      headers: { Authorization: `Bearer ${mediaAuthTokenRef.current}` },
                    }).catch(() => undefined);
                  }
                  throw new Error('Inicialização WebRTC cancelada.');
                }
                // A OUTRA METADE DO VAZAMENTO: a ref é ÚNICA por tile, então
                // guardar a nova URL por cima apagava o endereço da anterior —
                // e sem endereço não há como dar DELETE nela. A sessão velha
                // seguia VIVA e transmitindo (medido: 3 sessões da mesma câmera,
                // 28/25/5 MB, todas em estado `read`), porque o MediaMTX só
                // encerra quando o cliente deleta ou o ICE cai.
                //
                // O bloco acima cobre "esta tentativa ficou obsoleta"; este
                // cobre o inverso — "esta venceu, mas havia uma anterior". Sem
                // os dois, cada reconexão somava mais um fluxo do MESMO vídeo:
                // 17 câmeras viravam 30 sessões, a subida do servidor saturava
                // e TODOS os tiles caíam juntos, com o servidor ocioso.
                if (sessionUrl) {
                  const anterior = webrtcSessionUrlRef.current;
                  if (anterior && anterior !== sessionUrl) {
                    void fetch(anterior, {
                      method: 'DELETE',
                      mode: 'cors',
                      headers: { Authorization: `Bearer ${mediaAuthTokenRef.current}` },
                    }).catch(() => undefined);
                  }
                  webrtcSessionUrlRef.current = sessionUrl;
                }

                const remoteSdp = await response.text();
                if (cancelled || webrtcPcRef.current !== pc || abortController.signal.aborted) {
                  throw new Error('Inicialização WebRTC cancelada.');
                }
                await pc.setRemoteDescription({
                  type: 'answer',
                  sdp: remoteSdp,
                });
              } catch (error) {
                const message = abortController.signal.aborted
                  ? 'WebRTC excedeu o tempo de negociação com o servidor.'
                  : error instanceof Error ? error.message : 'Falha desconhecida no WebRTC.';
                finish(new Error(message));
              }
            })();
          });
        };

        const startHls = async (lowLatencyMode: boolean, protocolName: ActiveLiveProtocol) => {
          if (!hlsUrl) {
            throw new Error('Stream HLS indisponível.');
          }
          cleanupHls();
          await cleanupWebrtc();

          const HlsModule = await import('hls.js/dist/hls.mjs');
          const Hls = HlsModule.default;

          if (Hls.isSupported()) {
            const hls = new Hls({
              lowLatencyMode,
              liveSyncDurationCount: 1,
              liveMaxLatencyDurationCount: 3,
              maxLiveSyncPlaybackRate: 1.5,
              backBufferLength: 30,
              xhrSetup: (xhr) => {
                xhr.withCredentials = true;
                xhr.setRequestHeader('Authorization', `Bearer ${mediaAuthTokenRef.current}`);
              },
            });
            hlsRef.current = hls;
            const hlsFailure = new Promise<void>((_resolve, reject) => {
              hls.attachMedia(element);
              hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                hls.loadSource(hlsUrl);
              });
              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                if (autoPlay) void element.play().catch(() => {});
              });
              hls.on(Hls.Events.ERROR, (_event, dataError) => {
                if (cancelled) return;
                if (dataError?.fatal) {
                  if (activeProtocolRef.current === protocolName && hasFrameRef.current) {
                    failActiveProtocol('erro fatal do manifesto ou mídia HLS');
                  } else {
                    reject(new Error('Stream indisponível via HLS.'));
                  }
                }
              });
            });
            await Promise.race([waitForVisibleFrame(protocolName, HLS_FIRST_FRAME_TIMEOUT_MS), hlsFailure]);
            markHealthy(protocolName);
            return;
          }

          if (element.canPlayType('application/vnd.apple.mpegurl')) {
            throw new Error('HLS nativo sem suporte a token seguro; use um navegador com MediaSource/WebRTC.');
          }

          throw new Error('Navegador sem suporte para HLS.');
        };

        for (const protocol of protocolOrder) {
          let startupAttempt = 0;
          while (!cancelled) {
            try {
              if (protocol === 'webrtc' && whepUrl) {
                await startWebrtc(whepUrl);
                return;
              }
              if (protocol === 'llhls' && hlsUrl) {
                await startHls(true, 'LL-HLS');
                return;
              }
              if (protocol === 'hls' && hlsUrl) {
                await startHls(false, 'HLS');
                return;
              }
              break;
            } catch (protocolError) {
              const protocolName = protocol === 'webrtc' ? 'WebRTC' : protocol === 'llhls' ? 'LL-HLS' : 'HLS';
              const failureReason = protocolError instanceof Error ? protocolError.message : 'falha desconhecida';
              const retrySameWebrtc = protocol === 'webrtc'
                && shouldRetryWebrtcStartup(failureReason, startupAttempt);
              reportLiveFailure(protocol, retrySameWebrtc ? 'startup_retry' : 'startup', failureReason);
              if (noFrameTimeout != null) window.clearTimeout(noFrameTimeout);
              noFrameTimeout = null;
              cleanupHls();
              await cleanupWebrtc();
              if (!hasFrameRef.current) {
                setActiveProtocol(null);
                activeProtocolRef.current = null;
              }
              if (retrySameWebrtc) {
                startupAttempt += 1;
                setProtocolReason(`${protocolName} conectou sem primeiro quadro. Repetindo WebRTC antes da contingência.`);
                console.warn(`[LiveStreamPlayer:${cameraId}] ${protocolName} sem primeiro quadro; repetindo uma vez: ${failureReason}`);
                await new Promise((resolve) => window.setTimeout(resolve, 300));
                continue;
              }
              failedProtocolsRef.current.add(protocol);
              setProtocolReason(`${protocolName} falhou: ${failureReason}. Testando o próximo protocolo.`);
              console.warn(`[LiveStreamPlayer:${cameraId}] ${protocolName} falhou: ${failureReason}`);
              break;
            }
          }
        }

        if (shouldUseGridH264Fallback(deliveryMode, sourceCodec)) {
          failedProtocolsRef.current.clear();
          streamUrlsCache.clear(cacheKey);
          setProtocolReason('A fonte original não foi reproduzida neste cliente; ativando a contingência H.264.');
          setGridUsesH264Fallback(true);
          return;
        }
        if (deliveryMode === 'original' && videoCodecFamily(sourceCodec) === 'hevc') {
          failedProtocolsRef.current.clear();
          streamUrlsCache.clear(cacheKey);
          setQualityMode('instant');
          setProtocolReason('O teste real de H.265 falhou; usando a contingência H.264.');
          setNotice('O teste real de H.265 falhou neste navegador. Exibindo em H.264.');
          return;
        }

        failedProtocolsRef.current.clear();
        streamUrlsCache.clear(cacheKey);
        if (liveDiagnostics?.readiness?.state === 'blocked') {
          const action = liveDiagnostics.readiness.recommendedAction
            ? ` ${liveDiagnostics.readiness.recommendedAction}`
            : '';
          throw new Error(`${liveDiagnostics.readiness.userMessage ?? 'A transmissão não está pronta.'}${action}`);
        }
        if (liveDiagnostics && !liveDiagnostics.pathReady) {
          throw new Error('O MediaMTX ainda não publicou o caminho desta câmera. Verifique se a câmera está online e se o RTSP responde.');
        }
        throw new Error('Nenhum protocolo iniciou. Verifique WebRTC/WHEP, HLS, codec da câmera e conectividade com o MediaMTX.');
      } catch (streamError) {
        if (cancelled) return;
        if (axios.isAxiosError<CommercialRestrictionError>(streamError) && streamError.response?.status === 423) {
          const friendlyMessage =
            streamError.response.data?.userMessage
            ?? 'Transmissão temporariamente indisponível. Entre em contato com o administrador do sistema.';
          setError(friendlyMessage);
          setRetryMessage(null);
          setIsLoading(false);
          setActiveProtocol(null);
          activeProtocolRef.current = null;
          return;
        }
        if (
          axios.isAxiosError<CommercialRestrictionError>(streamError)
          && streamError.response?.status === 503
          && streamError.response.data?.error === 'rtmp_source_unavailable'
        ) {
          // A publicação pode ter acabado de chegar ao SRS e ainda estar sendo
          // anunciada pelo MediaMTX. Faça uma recuperação curta e limitada; se
          // a fonte estiver realmente desligada, a tela para com um diagnóstico
          // honesto em vez de manter "Conectando" eternamente.
          if (retryAttemptRef.current < RTMP_SOURCE_AUTO_RETRY_LIMIT) {
            scheduleReconnect('Aguardando transmissão RTMP da câmera');
            return;
          }
          scheduleRtmpBackgroundRecovery(
            streamError.response.data.userMessage
            ?? 'Aguardando transmissão RTMP da câmera.',
          );
          return;
        }
        const message = streamError instanceof Error ? streamError.message : 'Falha ao iniciar stream.';
        if (/401|403|unauthorized|forbidden|auth|credencial|senha/i.test(message)) {
          setError('Falha de autenticação da câmera: valide usuário/senha RTSP/ONVIF.');
          setRetryMessage(null);
          setIsLoading(false);
        } else {
          if (/Nenhum protocolo iniciou|MediaMTX|WebRTC|WHEP|HLS|codec/i.test(message) && !hasFrameRef.current) {
            setError(message);
            setRetryMessage('Tentaremos novamente automaticamente.');
            setIsLoading(false);
            scheduleReconnect(message);
          } else {
            scheduleReconnect(message);
          }
        }
      }
    };

    // Quando suspenso (aba oculta há muito tempo), o cleanup do ciclo anterior
    // já derrubou o WebRTC e deu DELETE na sessão; aqui apenas não rebootamos.
    // Ao voltar a ficar visível, `suspended` volta a false e o effect reexecuta,
    // disparando um boot fresco que re-anexa ao FFmpeg ainda aquecido no servidor.
    if (!suspended) {
      bootDelayTimeout = window.setTimeout(() => {
        void boot();
      }, Math.max(0, startDelayMsRef.current));
    }

    return () => {
      cancelled = true;
      if (bootDelayTimeout != null) window.clearTimeout(bootDelayTimeout);
      clearRetryTimer();
      if (noFrameTimeout != null) window.clearTimeout(noFrameTimeout);
      if (streamTokenRenewTimerRef.current != null) {
        window.clearTimeout(streamTokenRenewTimerRef.current);
        streamTokenRenewTimerRef.current = null;
      }
      if (webrtcAbortControllerRef.current) {
        try {
          webrtcAbortControllerRef.current.abort();
        } catch {
        }
        webrtcAbortControllerRef.current = null;
      }
      if (webrtcDisconnectTimerRef.current != null) {
        window.clearTimeout(webrtcDisconnectTimerRef.current);
        webrtcDisconnectTimerRef.current = null;
      }
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {
        }
        hlsRef.current = null;
      }
      if (webrtcPcRef.current) {
        try {
          webrtcPcRef.current.ontrack = null;
          webrtcPcRef.current.onconnectionstatechange = null;
          webrtcPcRef.current.oniceconnectionstatechange = null;
          webrtcPcRef.current.close();
        } catch {
        }
        webrtcPcRef.current = null;
      }
      if (webrtcStreamRef.current) {
        try {
          for (const track of webrtcStreamRef.current.getTracks()) {
            track.stop();
          }
        } catch {
        }
        webrtcStreamRef.current = null;
      }
      if (webrtcSessionUrlRef.current) {
        void fetch(webrtcSessionUrlRef.current, {
          method: 'DELETE',
          mode: 'cors',
          headers: { Authorization: `Bearer ${mediaAuthTokenRef.current}` },
        }).catch(() => undefined);
        webrtcSessionUrlRef.current = null;
      }
      const preserveFrame = preserveFrameOnReloadRef.current && hasFrameRef.current;
      preserveFrameOnReloadRef.current = false;
      if (!preserveFrame) {
        element.srcObject = null;
        element.removeAttribute('src');
        element.load();
      }
    };
  }, [hasAccessToken, authUserId, autoPlay, cameraId, deliveryMode, failActiveProtocol, framesAreProgressing, getFastRetryDelay, isLikelyBlackFrame, reportLiveFailure, requestFreshLiveBoot, reloadNonce, suspended]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    const markProgress = () => {
      if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      lastProgressRef.current = getPlaybackProgress(element);
    };

    element.addEventListener('timeupdate', markProgress);
    element.addEventListener('playing', markProgress);
    element.addEventListener('loadeddata', markProgress);
    element.addEventListener('canplay', markProgress);
    return () => {
      element.removeEventListener('timeupdate', markProgress);
      element.removeEventListener('playing', markProgress);
      element.removeEventListener('loadeddata', markProgress);
      element.removeEventListener('canplay', markProgress);
    };
  }, []);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || typeof element.requestVideoFrameCallback !== 'function') return;

    let callbackId: number | null = null;
    let cancelled = false;
    let fpsWindowStartedAt = performance.now();
    let fpsWindowFrames = 0;
    const onFrame = (_now: number, metadata: { mediaTime?: number; presentedFrames?: number }) => {
      if (cancelled) return;
      lastRenderedFrameRef.current = {
        wallTime: Date.now(),
        mediaTime: typeof metadata.mediaTime === 'number' && Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : element.currentTime,
        presentedFrames: metadata.presentedFrames ?? lastRenderedFrameRef.current.presentedFrames + 1,
      };
      fpsWindowFrames += 1;
      const elapsedMs = performance.now() - fpsWindowStartedAt;
      if (elapsedMs >= 1200) {
        setDisplayFps(Math.max(0, Math.round((fpsWindowFrames * 1000) / elapsedMs)));
        fpsWindowStartedAt = performance.now();
        fpsWindowFrames = 0;
      }
      callbackId = element.requestVideoFrameCallback(onFrame);
    };

    callbackId = element.requestVideoFrameCallback(onFrame);
    return () => {
      cancelled = true;
      setDisplayFps(null);
      if (callbackId != null && typeof element.cancelVideoFrameCallback === 'function') {
        element.cancelVideoFrameCallback(callbackId);
      }
    };
  }, []);

  useEffect(() => {
    // Cada perfil abre outro path/PeerConnection. Não carregue para a nova
    // qualidade a última amostra da conexão anterior: isso fazia o selo mostrar
    // por alguns segundos o bitrate do Instantâneo em "Máxima" (e vice-versa).
    lastBitrateSampleRef.current = null;
    setMeasuredBitrateKbps(null);

    if (liveViewMode !== 'selected' || activeProtocol !== 'WEBRTC') {
      return;
    }

    let cancelled = false;
    const sample = async () => {
      const pc = webrtcPcRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        // A qualidade pode ter trocado enquanto getStats() aguardava. Uma
        // resposta da conexão velha nunca deve sobrescrever a medição nova.
        if (cancelled || pc !== webrtcPcRef.current) return;
        let bytes = 0;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video' && !report.isRemote) {
            // Chrome expõe retransmissões RTX/FEC como outro inbound-rtp de
            // vídeo. Somá-lo ao fluxo principal podia quase duplicar o número
            // mostrado em redes com perda, embora não fossem pixels adicionais.
            const codec = report.codecId ? stats.get(report.codecId) : null;
            const mimeType = String(codec?.mimeType ?? '').toLowerCase();
            if (mimeType.includes('/rtx') || mimeType.includes('/red') || mimeType.includes('/ulpfec')) return;
            bytes += Number(report.bytesReceived ?? 0);
          }
        });
        const now = performance.now();
        const previous = lastBitrateSampleRef.current;
        lastBitrateSampleRef.current = { at: now, bytes };
        if (previous && bytes >= previous.bytes && now > previous.at) {
          const kbps = ((bytes - previous.bytes) * 8) / (now - previous.at);
          setMeasuredBitrateKbps(Math.max(0, Math.round(kbps)));
        }
      } catch {
        if (!cancelled) setMeasuredBitrateKbps(null);
      }
    };

    void sample();
    const interval = window.setInterval(() => void sample(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeProtocol, deliveryMode, liveViewMode]);

  useEffect(() => {
    if (activeProtocol !== 'HLS' && activeProtocol !== 'LL-HLS') {
      setLiveLatencySeconds(null);
      return;
    }
    const updateLatency = () => {
      const element = videoRef.current;
      if (!element?.seekable.length) return;
      const liveEdge = element.seekable.end(element.seekable.length - 1);
      const drift = liveEdge - element.currentTime;
      setLiveLatencySeconds(Number.isFinite(drift) ? Math.max(0, drift) : null);
    };
    updateLatency();
    const interval = window.setInterval(updateLatency, 1000);
    return () => window.clearInterval(interval);
  }, [activeProtocol]);

  useEffect(() => {
    const softResumeAtLiveEdge = () => {
      const element = videoRef.current;
      if (!element || !hasFrameRef.current) return;

      const protocol = activeProtocolRef.current;

      if (protocol === 'HLS') {
        try {
          hlsRef.current?.startLoad?.(-1);
          const liveSyncPosition = hlsRef.current?.liveSyncPosition;
          if (typeof liveSyncPosition === 'number' && Number.isFinite(liveSyncPosition)) {
            element.currentTime = Math.max(0, liveSyncPosition - LIVE_EDGE_OFFSET_SECONDS);
          } else {
            seekVideoToLiveEdge(element);
          }
        } catch {
          try {
            hlsRef.current?.recoverMediaError?.();
            hlsRef.current?.startLoad?.(-1);
          } catch {
          }
        }
      } else if (protocol === 'LL-HLS') {
        try {
          hlsRef.current?.startLoad?.(-1);
          seekVideoToLiveEdge(element);
        } catch {
        }
      }

      if (autoPlay) {
        void element.play().catch(() => {});
      }
    };

    const markHidden = () => {
      if (hiddenAtRef.current == null) {
        hiddenAtRef.current = Date.now();
      }
      // Agenda a suspensão: se a aba seguir oculta além do limite, derruba o
      // WebRTC para parar o transcode/banda no servidor.
      if (suspendTimerRef.current == null && !suspendedRef.current) {
        suspendTimerRef.current = window.setTimeout(() => {
          suspendTimerRef.current = null;
          if (!document.hidden) return;
          suspendedRef.current = true;
          setSuspended(true);
        }, LIVE_HIDDEN_SUSPEND_MS);
      }
    };

    const resumeFromBrowserLifecycle = (forceReconnect = false) => {
      const hiddenForMs = hiddenAtRef.current == null ? 0 : Date.now() - hiddenAtRef.current;
      hiddenAtRef.current = null;

      // Cancela qualquer suspensão pendente ao voltar à aba.
      if (suspendTimerRef.current != null) {
        window.clearTimeout(suspendTimerRef.current);
        suspendTimerRef.current = null;
      }

      // Se chegamos a suspender, basta retomar: o effect principal reexecuta e
      // faz um boot fresco que re-anexa ao FFmpeg ainda quente no servidor.
      if (suspendedRef.current) {
        suspendedRef.current = false;
        setSuspended(false);
        return;
      }

      if (forceReconnect) {
        softResumeAtLiveEdge();
        window.setTimeout(() => {
          const element = videoRef.current;
          if (!element || document.hidden) return;
          if (element.paused || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            requestFreshLiveBoot('Retomando câmera em tempo real...');
          }
        }, 900);
        return;
      }

      if (hiddenForMs > 0 && hiddenForMs < LIVE_RESUME_GRACE_MS) return;
      softResumeAtLiveEdge();

      if (hiddenForMs >= LIVE_SOFT_ONLY_RESUME_MS) {
        const before = lastProgressRef.current;
        window.setTimeout(() => {
          const element = videoRef.current;
          if (!element || document.hidden) return;
          const currentMediaTime = Number.isFinite(element.currentTime) ? element.currentTime : 0;
          const progressed = Math.abs(currentMediaTime - before.mediaTime) > 0.05;
          if (!progressed && element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            requestFreshLiveBoot('Retomando câmera em tempo real...');
          }
        }, 1200);
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        markHidden();
        return;
      }
      resumeFromBrowserLifecycle();
    };

    const onFocus = () => resumeFromBrowserLifecycle();
    const onPageShow = (event: PageTransitionEvent) => resumeFromBrowserLifecycle(event.persisted);
    const onPageHide = () => markHidden();
    const onFreeze = () => markHidden();
    const onResume = () => resumeFromBrowserLifecycle();

    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('freeze', onFreeze);
    document.addEventListener('resume', onResume);
    window.addEventListener('blur', markHidden);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    // Aba que JÁ nasce em segundo plano (clique-do-meio, "abrir em nova aba"):
    // nenhuma transição de visibilidade acontece, então a suspensão de 45s —
    // que existe exatamente para este caso — nunca engatava, e N sessões
    // WebRTC + transcode rodavam para sempre numa aba que ninguém viu.
    if (document.hidden) markHidden();
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('freeze', onFreeze);
      document.removeEventListener('resume', onResume);
      window.removeEventListener('blur', markHidden);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
      if (suspendTimerRef.current != null) {
        window.clearTimeout(suspendTimerRef.current);
        suspendTimerRef.current = null;
      }
    };
  }, [autoPlay, requestFreshLiveBoot]);

  useEffect(() => {
    const softRecoverStalledPlayer = () => {
      const element = videoRef.current;
      if (!element) return;

      const protocol = activeProtocolRef.current;
      if (protocol === 'HLS') {
        try {
          hlsRef.current?.startLoad?.(-1);
          seekVideoToLiveEdge(element);
        } catch {
          try {
            hlsRef.current?.recoverMediaError?.();
          } catch {
          }
        }
      } else if (protocol === 'LL-HLS') {
        try {
          hlsRef.current?.startLoad?.(-1);
          seekVideoToLiveEdge(element);
        } catch {
        }
      }

      if (autoPlay) {
        void element.play().catch(() => {});
      }
    };

    const sampleWebrtcInbound = async () => {
      const pc = webrtcPcRef.current;
      const health = webrtcInboundRef.current;
      if (!pc || health.polling || health.recoveryRequested) return;
      if (pc.connectionState !== 'connected'
        && pc.iceConnectionState !== 'connected'
        && pc.iceConnectionState !== 'completed') return;

      health.polling = true;
      try {
        const stats = await pc.getStats();
        if (webrtcPcRef.current !== pc || activeProtocolRef.current !== 'WEBRTC') return;
        let bytesReceived = 0;
        let framesDecoded = 0;
        let hasDecodedFrameMetric = false;
        stats.forEach((report) => {
          if (report.type !== 'inbound-rtp' || report.kind !== 'video' || report.isRemote) return;
          bytesReceived += Number(report.bytesReceived ?? 0);
          const frames = Number(report.framesDecoded ?? report.framesReceived ?? Number.NaN);
          if (Number.isFinite(frames)) {
            framesDecoded += frames;
            hasDecodedFrameMetric = true;
          }
        });
        const sample: WebrtcInboundSample = {
          bytesReceived,
          framesDecoded: hasDecodedFrameMetric ? framesDecoded : null,
        };
        const now = Date.now();
        if (hasWebrtcInboundProgress(health.sample, sample)) {
          health.sample = sample;
          health.lastProgressAt = now;
          health.recoveryRequested = false;
          return;
        }
        health.sample = sample;
        if (now - health.lastProgressAt < WEBRTC_RTP_STALL_RECONNECT_MS) return;

        // O RTP realmente parou. Reabre o MESMO WebRTC uma vez; não marca o
        // protocolo como incompatível por uma falha transitória de transporte.
        health.recoveryRequested = true;
        const reason = 'WebRTC sem avanço de frames RTP por 30 segundos';
        reportLiveFailure('webrtc', 'runtime', reason, 'WEBRTC');
        requestFreshLiveBoot('Transmissão WebRTC interrompida. Reconectando…', true);
      } catch {
        // getStats é diagnóstico local. Falhar ao consultá-lo nunca derruba
        // uma live que o operador ainda está vendo.
      } finally {
        health.polling = false;
      }
    };

    const interval = window.setInterval(() => {
      if (!routeActive || document.hidden || isLoading || error || !hasFrameRef.current) return;

      const element = videoRef.current;
      if (!element) return;

      if (autoPlay && element.paused) {
        void element.play().catch(() => {});
      }

      const now = Date.now();
      const renderedFrame = lastRenderedFrameRef.current;
      const protocol = activeProtocolRef.current;

      if (protocol === 'WEBRTC') {
        void sampleWebrtcInbound();
        // rVFC mede o compositor, não a rede. Com 25+ tiles ele pode ser
        // estrangulado em lote; WebRTC usa exclusivamente inbound-rtp acima.
        return;
      }
      // Only trigger the rVFC stall watchdog when the video is actually playing.
      // rVFC stops firing when the element is paused (e.g. autoplay blocked by
      // the browser policy), which would otherwise cause a spurious reconnect
      // after LIVE_RENDER_STALL_RECONNECT_MS even though nothing is wrong.
      if (
        typeof element.requestVideoFrameCallback === 'function'
        && !element.paused
        && now - renderedFrame.wallTime >= LIVE_RENDER_STALL_RECONNECT_MS
      ) {
        failActiveProtocol('imagem congelada sem novos frames');
        return;
      }

      // Detecção de frame PRETO persistente (readback de GPU custoso → só no tile
      // em destaque). Mede ausência real de vídeo, não falta de movimento.
      //
      // IMPORTANTE: NÃO usamos mais detecção de "congelamento" por mudança de pixels.
      // Cena estática (corredor vazio, parede, portão parado) entrega frames idênticos
      // o tempo todo numa câmera 100% saudável — reconectar nesse caso é falso-positivo
      // e fazia a tela piscar a cada ~45s sem motivo. O sinal correto de vivacidade é o
      // watchdog de render (rVFC) acima: se frames novos continuam sendo apresentados,
      // o stream está vivo, com ou sem movimento na cena.
      if (liveViewMode === 'selected') {
        // Preto NÃO derruba mais o transporte sozinho. Só há falha real quando a
        // imagem está preta E os quadros pararam de avançar — aí de fato não está
        // chegando vídeo. Madrugada, lente coberta e infravermelho entregam preto
        // com quadros correndo normalmente, e trocar de protocolo ali só produzia
        // piscada numa câmera saudável.
        if (isLikelyBlackFrame(element) && !framesAreProgressing(element)) {
          if (blackFrameSinceRef.current == null) blackFrameSinceRef.current = now;
          if (now - blackFrameSinceRef.current >= LIVE_BLACK_FRAME_FAILOVER_MS) {
            blackFrameSinceRef.current = null;
            failActiveProtocol('sem imagem: quadros pararam de avançar');
            return;
          }
        } else {
          blackFrameSinceRef.current = null;
        }
      }

      // O ramo WebRTC já retornou depois de consultar inbound-rtp. Daqui em
      // diante existem apenas HLS/LL-HLS, onde currentTime é sinal confiável.
      const currentMediaTime = Number.isFinite(element.currentTime) ? element.currentTime : 0;
      const lastProgress = lastProgressRef.current;
      if (Math.abs(currentMediaTime - lastProgress.mediaTime) > 0.05) {
        lastProgressRef.current = { wallTime: now, mediaTime: currentMediaTime };
        return;
      }

      const stalledForMs = now - lastProgress.wallTime;
      if (stalledForMs >= LIVE_STALL_RECONNECT_MS) {
        failActiveProtocol('transmissão sem progresso');
        return;
      }

      if (stalledForMs >= LIVE_STALL_SOFT_RECOVER_MS) {
        softRecoverStalledPlayer();
        return;
      }

      // Recuperação de latência (HLS/LL-HLS). Antes: SALTO seco para a borda ao
      // vivo sempre que a deriva passava de 3,5s — visível como "pulo" na imagem.
      // Agora, técnica do Frigate: deriva moderada é absorvida ACELERANDO a
      // reprodução suavemente (curva exponencial, teto 1,5×) até reencostar no
      // ao vivo — o operador não percebe o ajuste. O salto seco fica só para
      // deriva grande (ex.: aba oculta), onde acelerar demoraria demais.
      if (protocol === 'HLS' || protocol === 'LL-HLS') {
        const ranges = element.seekable;
        if (ranges.length > 0) {
          const liveEdge = ranges.end(ranges.length - 1);
          const drift = liveEdge - element.currentTime;
          if (Number.isFinite(drift)) {
            if (drift > LIVE_DRIFT_HARD_SEEK_SECONDS) {
              element.playbackRate = 1;
              seekVideoToLiveEdge(element);
            } else if (drift > LIVE_DRIFT_CATCHUP_SECONDS) {
              const rate = Math.min(
                LIVE_DRIFT_MAX_RATE,
                1 + 0.2 * Math.exp(0.5 * (drift - LIVE_DRIFT_CATCHUP_SECONDS)),
              );
              if (Math.abs(element.playbackRate - rate) > 0.02) element.playbackRate = rate;
            } else if (element.playbackRate !== 1) {
              element.playbackRate = 1; // reencostou: volta ao tempo normal
            }
          }
        }
      } else if (element.playbackRate !== 1) {
        // WebRTC não acumula buffer: nunca deve ficar acelerado.
        element.playbackRate = 1;
      }
    }, LIVE_STALL_CHECK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [autoPlay, error, failActiveProtocol, framesAreProgressing, isLikelyBlackFrame, isLoading, liveViewMode, reportLiveFailure, requestFreshLiveBoot, routeActive]);

  useEffect(() => {
    if (!aiOverlayEnabled || !tokenHeadersRef.current) return;
    const sessionId = liveViewSessionIdRef.current;

    const postLease = async (action: 'start' | 'heartbeat' | 'stop') => {
      try {
        await axios.post(
          `${API_URL}/ai/live-view/${action}/${cameraId}`,
          { sessionId, ttlSeconds: LIVE_VIEW_LEASE_TTL_SECONDS, viewMode: liveViewModeRef.current },
          // Token via REF, como no efeito principal de conexão (linhas ~517):
          // com o token nas deps, a rotação de 5 min re-executava o efeito e
          // disparava stop+start quase simultâneos com o MESMO sessionId — se
          // o stop chegasse depois, matava o lease recém-criado e a análise
          // daquela câmera ficava morta até o próximo heartbeat. Numa grade de
          // 20 câmeras eram 40 requisições inúteis a cada 5 minutos.
          { headers: tokenHeadersRef.current },
        );
      } catch {
      }
    };

    void postLease('start');
    const heartbeat = window.setInterval(() => {
      void postLease('heartbeat');
    }, LIVE_VIEW_HEARTBEAT_MS);

    return () => {
      window.clearInterval(heartbeat);
      void postLease('stop');
    };
  }, [aiOverlayEnabled, cameraId]);

  useEffect(() => {
    if (!aiOverlayEnabled || !accessToken || error) {
      setDetections([]);
      return;
    }

    // Assina o poller compartilhado: todos os tiles são agregados em uma única
    // requisição em lote por ciclo, em vez de uma requisição por câmera.
    const unsubscribe = liveDetectionsPoller.subscribe(cameraId, setDetections);
    return () => {
      unsubscribe();
      setDetections([]);
    };
  }, [accessToken, aiOverlayEnabled, cameraId, error]);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden bg-black ${className ?? ''}`}
      aria-label={`Live ${cameraName}`}
      onDoubleClick={resetZoom}
    >
      <div
        className="absolute inset-0 w-full h-full"
        style={{
          // translate ANTES do scale, origem no canto (0 0): assim o pan é em
          // pixels de tela e o zoom "entra" onde o mouse aponta. A transição
          // suave só no repouso (voltar ao 1×) — arrastando tem de ser imediato.
          transform: zoom !== 1 ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` : undefined,
          transformOrigin: '0 0',
          transition: zoom === 1 ? 'transform 0.2s ease-out' : 'none',
        }}
      >
        {posterUrl && !hasLiveFrame && !posterFailed && (
          <img
            src={posterUrl}
            alt=""
            // O poster é uma IMAGEM ESTÁTICA de cortesia, exibida enquanto o vídeo
            // não chega. Ele falhar não diz NADA sobre a transmissão — e antes
            // chamava requestFreshLiveBoot: uma miniatura com erro interrompia uma
            // negociação de vídeo perfeitamente saudável. Agora ele só some.
            onError={() => setPosterFailed(true)}
              // O poster usa o mesmo encaixe do vídeo para não haver um salto
              // visual quando chega o primeiro quadro.
              className={`absolute inset-0 h-full w-full opacity-80 ${
                liveViewMode === 'grid' ? 'object-cover' : 'object-contain'
              }`}
            draggable={false}
          />
        )}

        <video
          ref={videoRef}
            // Mosaico profissional: todos os tiles são preenchidos e alinhados.
            // A API primeiro tenta entregar uma fonte com a MESMA proporção da
            // principal; `cover` é apenas a proteção final para câmera/RTMP que
            // só oferece 4:3. Na visualização individual usamos `contain`, onde
            // o operador pode inspecionar 100% da cena sem corte.
            // O overlay da IA lê objectFit e corrige sua geometria nos dois casos.
            className={`relative z-10 h-full w-full pointer-events-none transition-opacity duration-300 ${
              liveViewMode === 'grid' ? 'object-cover' : 'object-contain'
            } ${
              posterUrl && !hasLiveFrame ? 'opacity-0' : 'opacity-100'
            }`}
          muted={isMuted}
          playsInline
          autoPlay={autoPlay}
        />
      </div>

      {/* MÃOZINHA — só existe quando ampliado. Fica ACIMA do botão de seleção
          (z-[15], irmão do player) para (a) mostrar o cursor de arraste e (b)
          impedir que arrastar o vídeo dispare a seleção/desseleção da câmera. O
          arraste em si é tratado pelos ouvintes de janela (o botão cobre o
          player e não é filho dele); aqui só entregamos o cursor certo. */}
      {liveViewMode === 'selected' && zoom > 1 && (
        <div
          // z-[18]: ACIMA do botão de seleção (z-[15], irmão do player) para
          // pegar o cursor de mão e barrar a desseleção acidental ao arrastar,
          // mas ABAIXO dos controles (z-30: mudo, qualidade, selos) — que seguem
          // clicáveis mesmo ampliado.
          className="absolute inset-0 z-[18]"
          style={{ cursor: dragging ? 'grabbing' : 'grab' }}
          aria-hidden
        />
      )}

      {aiOverlayEnabled && (
        // Overlay em componente PRÓPRIO: o hook de interpolação re-renderiza a
        // 60 fps, mas só o overlay — o player fica no ritmo do poller. A
        // identidade por trackId e a matemática de posicionamento foram para
        // lá; o que eu tinha feito com transição CSS vira interpolação real em
        // JS (pacote de tracking, 15/08/2026).
        <SmoothDetectionOverlay
          detections={detections}
          videoRef={videoRef}
          containerRef={containerRef}
        />
      )}

      {showOverlay && (isLoading || audioSwitchMessage) && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
          <div className={`flex items-center gap-2 rounded-md border border-white/10 bg-black/45 text-white/75 ${
            compactLiveOverlay ? 'px-2 py-1 text-[10px]' : 'px-3 py-2 text-xs'
          }`}>
            <LoaderCircle className={`${compactLiveOverlay ? 'h-3 w-3' : 'h-4 w-4'} animate-spin`} />
            {audioSwitchMessage ?? loadingLabel}
          </div>
        </div>
      )}

      {showOverlay && error && compactLiveOverlay && (
        <div className="absolute inset-x-1 bottom-1 z-20 flex justify-center">
          <div className="flex max-w-[92%] items-center gap-1.5 rounded border border-white/10 bg-black/68 px-2 py-1 text-[10px] text-white/75 backdrop-blur-[2px]">
            <AlertTriangle className="h-3 w-3 shrink-0 text-[hsl(var(--status-warning))]" />
            <span className="truncate">{compactErrorLabel}</span>
          </div>
        </div>
      )}

      {showOverlay && error && !compactLiveOverlay && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
          <div className="max-w-[85%] rounded-lg border border-[hsl(var(--destructive)_/_0.3)] bg-[hsl(var(--destructive)_/_0.1)] px-4 py-3 text-center text-xs text-[hsl(var(--destructive))]">
            <div className="mb-2 flex items-center justify-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Sem imagem da câmera
            </div>
            <div>{friendlyLiveText(error, 'Não foi possível conectar à câmera agora. A reconexão é automática — verifique se a câmera está ligada e com rede.')}</div>
            {errorIsTechnical && (
              <details className="mt-2 text-left text-[10px] text-[hsl(var(--destructive))]/70">
                <summary className="cursor-pointer select-none">Detalhes técnicos</summary>
                <div className="mt-1 break-words font-mono text-[9px]">{error}</div>
              </details>
            )}
            <button
              type="button"
              onClick={() => {
                retryAttemptRef.current = 0;
                rtmpBackgroundRecoveryRef.current = false;
                setError(null);
                setIsLoading(true);
                setReloadNonce((value) => value + 1);
              }}
              className="mt-3 inline-flex h-8 items-center justify-center rounded border border-[hsl(var(--destructive)_/_0.35)] bg-black/30 px-3 text-[11px] text-[hsl(var(--destructive))] hover:bg-black/45"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      )}

      {notice && !error && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-4">
          <div
            role="status"
            className="pointer-events-auto flex max-w-[92%] items-start gap-2 rounded-lg border border-amber-400/40 bg-black/80 px-3 py-2 text-[11.5px] leading-snug text-amber-100 shadow-lg backdrop-blur-sm"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span>{notice}</span>
            <button
              type="button"
              aria-label="Fechar aviso"
              onClick={() => setNotice(null)}
              className="ml-1 shrink-0 rounded px-1 text-amber-200/70 hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-300"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {zoom > 1 && (
        <div className="absolute top-2 left-2 z-30 rounded-sm border border-white/10 bg-black/45 px-1.5 py-0.5 text-[9px] font-mono text-white/70">
          {zoom.toFixed(1)}×
        </div>
      )}

      {showOverlay && (activeProtocol || displayFps != null || liveViewMode === 'selected') && (
        <div className="absolute top-2 right-2 z-30 flex max-w-[78%] flex-wrap items-center justify-end gap-1.5 opacity-85 transition-opacity hover:opacity-100">
          {liveViewMode === 'selected' && (
            <span
              role="group"
              aria-label="Qualidade da transmissão ao vivo"
              className="inline-flex items-center gap-0.5 rounded-md border border-white/15 bg-black/60 p-0.5 backdrop-blur-sm shadow-sm"
            >
              {([
                ['instant', 'Instantâneo', 'Substream da câmera: imagem menor, menor latência e menos banda. Use em redes lentas ou muitas câmeras.'],
                [
                  'max',
                  'Máxima resolução',
                  browserHevcKnown
                    ? 'Vídeo original da câmera sem conversão (preserva o H.265 quando a câmera usa esse codec). Pode ter 1–3 s de atraso.'
                    : 'Vídeo original sem conversão. O navegador não declarou H.265; o sistema fará um teste real e voltará automaticamente ao Instantâneo (H.264) se não reproduzir.',
                ],
              ] as const).map(([mode, label, hint]) => {
                const isActive = qualityMode === mode;
                // Máxima só "degrada" quando a câmera ATUAL é H.265 E o navegador não a
                // decodifica → aí a Máxima cai para H.264. Numa câmera H.264, a Máxima
                // (passthrough) funciona em qualquer navegador, então não marca nada.
                const cameraIsHevc = /h265|hevc|hvc1|265/i.test(String(sourceVideoCodec ?? ''));
                const maxDegraded = mode === 'max' && !browserHevcKnown && cameraIsHevc;
                return (
                  <button
                    key={mode}
                    type="button"
                    title={hint}
                    aria-pressed={isActive}
                    aria-label={`Qualidade ${label}`}
                    onClick={() => changeQuality(mode)}
                    className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[10.5px] font-semibold tracking-wide transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${
                      isActive
                        ? 'bg-[hsl(var(--primary))] text-white shadow'
                        : 'text-white/75 hover:bg-white/15 hover:text-white'
                    }`}
                  >
                    {label}
                    {maxDegraded ? <span className="text-[8px] font-normal opacity-70" aria-hidden="true">H.265</span> : null}
                  </button>
                );
              })}
            </span>
          )}
          {!compactLiveOverlay && videoRef.current?.videoWidth ? (
            <span className="inline-flex h-6 items-center rounded border border-white/15 bg-black/55 px-2 text-[10px] font-semibold tracking-wide text-white/80">
              {videoRef.current.videoWidth}×{videoRef.current.videoHeight}
            </span>
          ) : null}
          {!compactLiveOverlay && sourceVideoCodec ? (
            <span
              className={`inline-flex h-6 items-center gap-1 rounded border px-2 text-[10px] font-semibold uppercase tracking-wide ${
                showsVideoTranscode
                  ? 'border-amber-400/50 bg-amber-500/20 text-amber-100'
                  : 'border-white/15 bg-black/55 text-white/80'
              }`}
              title={
                showsVideoTranscode && transcodeCost
                  ? 'O vídeo foi ajustado para funcionar melhor neste dispositivo.'
                  : undefined
              }
            >
              {showsVideoTranscode ? 'Vídeo otimizado' : 'Qualidade original'}
            </span>
          ) : null}
          {!compactLiveOverlay && measuredBitrateKbps != null ? (
            <span className="inline-flex h-6 items-center rounded border border-white/15 bg-black/55 px-2 text-[10px] font-semibold tracking-wide text-white/80">
              {measuredBitrateKbps >= 1000
                ? `${(measuredBitrateKbps / 1000).toFixed(1)} Mbps`
                : `${measuredBitrateKbps} kbps`}
            </span>
          ) : null}
          {displayFps != null && (
            <span className="inline-flex h-4 items-center rounded-sm border border-white/10 bg-black/40 px-1.5 text-[8px] font-medium tracking-wider text-white/65">
              {displayFps} FPS
            </span>
          )}
          {activeProtocol && (
          <span
            className={`inline-flex h-4 items-center rounded-sm border px-1.5 text-[8px] font-medium tracking-wider ${
              activeProtocol === 'WEBRTC'
                ? 'border-[hsl(var(--status-online)_/_0.25)] bg-black/40 text-[hsl(var(--status-online))]/85'
                : activeProtocol === 'HLS'
                  ? 'border-[hsl(var(--status-warning)_/_0.25)] bg-black/40 text-[hsl(var(--status-warning))]/85'
                  : 'border-[hsl(var(--primary)_/_0.25)] bg-black/40 text-[hsl(var(--primary))]/85'
            }`}
          >
            {activeProtocol === 'WEBRTC'
              ? 'WEBRTC'
              : activeProtocol === 'LL-HLS'
                ? 'LL-HLS'
                : 'HLS'}
          </span>
          )}
        </div>
      )}

      {showOverlay && !compactLiveOverlay && (activeProtocol === 'HLS' || activeProtocol === 'LL-HLS') && (
        <button
          type="button"
          onClick={() => {
            const element = videoRef.current;
            if (element) seekVideoToLiveEdge(element);
          }}
          className="absolute bottom-2 left-2 z-30 inline-flex h-7 items-center gap-1.5 rounded-full border border-[hsl(var(--status-online)_/_0.35)] bg-black/60 px-2.5 text-[9px] font-semibold text-[hsl(var(--status-online))] hover:bg-black/75"
          title="Voltar para a borda ao vivo"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          Ao vivo{liveLatencySeconds != null ? ` · ${liveLatencySeconds.toFixed(1)}s` : ''}
        </button>
      )}

      {showOverlay && !isLoading && !error && (
        <button
          type="button"
          onClick={() => {
            const nextMuted = !isMuted;
            if (liveViewMode === 'grid' && nextMuted !== isMuted) {
              // Só o clique que liga/desliga áudio reconecta este tile. A
              // grade inteira continua no H.264 em passthrough, sem áudio.
              if (hasFrameRef.current) preserveFrameOnReloadRef.current = true;
              setAudioSwitchMessage(nextMuted ? 'Desativando áudio…' : 'Ativando áudio…');
              setGridAudioRequested(!nextMuted);
            }
            setIsMuted(nextMuted);
            const element = videoRef.current;
            if (element) {
              element.muted = nextMuted;
              element.volume = nextMuted ? element.volume : 1;
              if (!nextMuted) {
                void element.play().catch(() => {
                  // Alguns navegadores exigem novo gesto se a aba perdeu foco; o botão continua disponível.
                });
              }
            }
          }}
          className="absolute bottom-2 right-2 z-30 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/55 text-white/80 transition-colors hover:bg-black/70 hover:text-white"
          title={isMuted ? 'Ativar áudio' : 'Mutar áudio'}
        >
          {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      )}

      {!cameraId && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
          <div className="flex items-center gap-2 text-xs text-white/60">
            <VideoOff className="h-4 w-4" />
            Nenhuma câmera selecionada
          </div>
        </div>
      )}
    </div>
  );
}
