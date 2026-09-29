import axios from 'axios';
import { create } from 'zustand';
import { useAuthStore } from './authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { cameraPublicIdLabel } from '../lib/camera-list-metadata';

export interface Camera {
  id: string;
  updatedAt?: string;
  /** Chave operacional curta e única; o UUID em `id` continua sendo interno. */
  publicId?: number | null;
  code: string;
  name: string;
  location: string;
  zone: string;
  building: string;
  floor: string;
  ipAddress: string;
  /** Origem real do vídeo. No push não existe IP RTSP para exibir ou editar. */
  sourceMode: 'rtsp_pull' | 'rtmp_push';
  siteId?: string | null;
  areaId?: string | null;
  locationAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  rtmpIngestPath?: string | null;
  rtspPort: number;
  model: string;
  status: 'online' | 'offline' | 'recording' | 'motion' | 'alarm' | 'no_signal' | 'maintenance' | 'checking';
  fps: number;
  resolution: string;
  storage: string;
  storageUsedBytes: number;
  storageLocalBytes: number;
  storageCloudBytes: number;
  lastEvent?: string;
  ptzCapable: boolean;
  /** Estado BRUTO da sonda: true/false = respondido, null = ainda não sondada
   *  (câmera offline, tipicamente). `ptzCapable` colapsa null em false para
   *  não oferecer controle incerto; este campo preserva a diferença, que é o
   *  que permite explicar ao operador por que a lista está vazia. */
  ptzDetectado: boolean | null;
  hasAudio: boolean;
  aiEnabled: boolean;
  objectMode: 'auto' | 'sempre' | 'nunca';
  aiObjectClasses: string[];
  aiSensitivity: 'sensitive' | 'balanced' | 'precise';
  aiConfidence: number;
  alarmsEnabled: boolean;
  /** Câmera ativa no sistema; false = desativada (não mostra nem grava). */
  enabled: boolean;
  isOnline: boolean;
  signalStrength: number;
  recordingMode: 'continuous' | 'motion' | 'object' | 'schedule' | 'manual';
  retentionDays: number;
  effectiveRetentionDays: number;
  /** Segue a política do grupo? Ausente em API antiga = segue (o padrão). */
  retentionFollowsGroup?: boolean;
  preferredRtspTransport: 'tcp' | 'udp';
  preferredLiveProtocol: 'auto' | 'flv' | 'hls' | 'llhls' | 'webrtc' | 'mjpeg';
  rtspPath?: string;
  liveChannel?: number | null;
  liveSubtype?: number | null;
  recordingChannel?: number | null;
  recordingSubtype?: number | null;
  analyticsChannel?: number | null;
  analyticsSubtype?: number | null;
  streamVideoCodec?: string;
  streamWidth?: number | null;
  streamHeight?: number | null;
  streamFps?: number | null;
  streamBitrateKbps?: number | null;
  recordingVideoCodec?: string;
  recordingWidth?: number | null;
  recordingHeight?: number | null;
  recordingFps?: number | null;
  recordingBitrateKbps?: number | null;
  detectedVideoCodec?: string;
  detectedWidth?: number | null;
  detectedHeight?: number | null;
  detectedFps?: number | null;
  detectedBitrateKbps?: number | null;
  lastMotion?: string;
  thumbnailColor: string;
  recordingStatusDetail?: string;
  /** Estado transitório do botão REC do operador, separado de regras automáticas. */
  manualRecordingActive?: boolean;
  recordingStale?: boolean;
  lastSegmentAt?: string | null;
  lastSegmentAgeSeconds?: number | null;
  /** Câmera privada do cliente (LGPD): conteúdo só do dono. */
  isPrivate?: boolean;
  /** Este usuário pode ver o CONTEÚDO? (false p/ admin numa câmera privada de terceiro). */
  canViewContent?: boolean;
  /** Zonas/linhas de perímetro. Só o `kind`/`sentido` importam para o resumo da
   *  página de Segurança; o desenho fica no editor do detalhe da câmera. */
  detectionZones?: Array<{ kind: 'include' | 'exclude' | 'line'; sentido?: 'ambos' | 'ab' | 'ba' }>;
}

export interface User {
  id: string;
  name: string;
  username?: string;
  role: 'viewer' | 'operator' | 'admin';
  email?: string | null;
  badge: string;
  lastLogin: string;
  shift: 'morning' | 'afternoon' | 'night';
  active: boolean;
}

export interface VMSEvent {
  id: string;
  type: string;
  cameraId: string;
  cameraName: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'critical';
  acknowledged: boolean;
  description: string;
  thumbnail?: string;
}

export interface Alarm {
  id: string;
  name: string;
  type: string;
  status: 'active' | 'acknowledged' | 'resolved';
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  triggeredAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  cameraId: string;
  zone: string;
  description: string;
  notes?: string;
  isSnoozed?: boolean;
  snoozedUntil?: string;
  transitionHistory?: Array<Record<string, unknown>>;
  notificationDelivery?: Array<Record<string, unknown>>;
  lastNotificationStatus?: string;
  occurrenceCount?: number;
  lastOccurredAt?: string;
}

export interface SavedLayout {
  id: string;
  name: string;
  gridSize: `${number}x${number}`;
  cameraIds: string[];
  createdBy: string;
  lastUsed: string;
  origem?: 'meu' | 'recebido';
  podeEditar?: boolean;
}

interface OverviewSummary {
  total: number;
  online: number;
  offline: number;
  error: number;
  unknown: number;
  recordingEnabled: number;
}

interface SystemSummary {
  status: string;
  service: string;
  recordingsRoot: string;
  server: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    uptimeSeconds: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    cpuCount: number;
    loadAverage: number[];
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
  };
  recordings: {
    count: number;
    totalBytes: number;
    lastStartedAt: string | null;
  };
  time: string;
}

interface RecordingItem {
  id: string;
  cameraId: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  sizeBytes: string;
  playUrl: string;
  thumbnailUrl: string | null;
}

interface AuditLogItem {
  id: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
}

interface VmsDataState {
  cameras: Camera[];
  users: User[];
  events: VMSEvent[];
  alarms: Alarm[];
  recordings: RecordingItem[];
  layouts: SavedLayout[];
  overview: OverviewSummary | null;
  system: SystemSummary | null;
  auditLogs: AuditLogItem[];
  operationsTimeline: Array<{
    kind: 'event' | 'alarm' | 'action';
    at: string;
    cameraId: string | null;
    cameraName: string | null;
    severity: string;
    type: string;
    message: string;
    eventId: string | null;
    alarmId: string | null;
    alarmStatus: string | null;
    action: string | null;
    actor: string | null;
  }>;
  isLoading: boolean;
  isRefreshing: boolean;
  loaded: boolean;
  error: string | null;
  stale: boolean;
  lastUpdatedAt: string | null;
  resourceErrors: Record<string, string>;
  load: () => Promise<void>;
  refreshOperational: () => Promise<void>;
  updateUserActive: (id: string, active: boolean) => Promise<void>;
  acknowledgeAlarm: (id: string, note?: string) => Promise<void>;
  resolveAlarm: (id: string, note?: string) => Promise<void>;
  snoozeAlarm: (id: string, minutes?: number, note?: string) => Promise<void>;
  unsnoozeAlarm: (id: string, note?: string) => Promise<void>;
  bulkAlarmAction: (action: 'ack' | 'resolve' | 'snooze' | 'unsnooze', eventIds: string[], opts?: { note?: string; minutes?: number }) => Promise<void>;
  addNote: (id: string, note: string) => void;
}

type RecordingRuntimeStatus = {
  cameraId: string;
  isRecording: boolean;
  manualRecordingActive?: boolean;
  intendedRecording?: boolean;
  stale?: boolean;
  statusDetail?: string;
  lastSegmentAt?: string | null;
  lastSegmentAgeSeconds?: number | null;
};

type SettledResource<T> = {
  data: T | null;
  error: string | null;
};

async function fetchResource<T>(name: string, request: Promise<{ data: T }>): Promise<SettledResource<T>> {
  try {
    const response = await request;
    return { data: response.data, error: null };
  } catch {
    // O painel do cliente informa a indisponibilidade do conteúdo, sem exibir
    // endpoint, código HTTP ou detalhe do serviço que falhou.
    return { data: null, error: `Não foi possível atualizar ${name} agora.` };
  }
}

function mapEventItems(rawEvents: any[]): VMSEvent[] {
  return rawEvents.map((event: any) => ({
    id: event.id,
    type: event.type,
    cameraId: event.cameraId,
    cameraName: event.cameraName ?? event.camera?.name ?? 'Câmera',
    timestamp: event.occurredAt,
    severity: mapSeverity(event.severity),
    acknowledged: Boolean(event.acknowledgedAt || event.acknowledgedBy),
    description: event.message,
  }));
}

function mapCameraItems(
  rawCameras: any[],
  rawEvents: any[],
  runtimeStatuses: Map<string, RecordingRuntimeStatus>,
  previousCameras: Camera[] = [],
): Camera[] {
  const previousById = new Map(previousCameras.map((camera) => [camera.id, camera] as const));
  return rawCameras.map((camera: any, index: number) => {
    const lastEvent = rawEvents.find((event: any) => event.cameraId === camera.id)?.occurredAt;
    const runtime = runtimeStatuses.get(camera.id);
    const previous = previousById.get(camera.id);
    const configuredStreamWidth = camera.streamWidth ?? null;
    const configuredStreamHeight = camera.streamHeight ?? null;
    const detectedStreamWidth = camera.detectedWidth ?? configuredStreamWidth;
    const detectedStreamHeight = camera.detectedHeight ?? configuredStreamHeight;
    const effectiveFps = camera.streamFps ?? camera.detectedFps ?? 0;
    const effectiveRecordingMode = (camera.recordingMode ?? (camera.recordingEnabled ? 'continuous' : 'manual')) as Camera['recordingMode'];
    const sourceMode: Camera['sourceMode'] = camera.sourceMode === 'rtmp_push' ? 'rtmp_push' : 'rtsp_pull';
    const sourceLabel = sourceMode === 'rtmp_push' ? 'RTMP push' : camera.ip;
    return {
      id: camera.id,
      publicId: Number.isSafeInteger(Number(camera.publicId)) ? Number(camera.publicId) : null,
      code: cameraPublicIdLabel(camera.publicId, camera.id),
      name: camera.name,
      location: sourceLabel,
      zone: camera.area?.name ?? camera.site?.name ?? previous?.zone ?? 'Sem zona',
      building: camera.site?.name ?? previous?.building ?? 'Sem unidade',
      floor: camera.group?.name ?? previous?.floor ?? '-',
      ipAddress: sourceLabel,
      sourceMode,
      siteId: camera.siteId ?? null,
      areaId: camera.areaId ?? null,
      locationAddress: camera.locationAddress ?? null,
      // Number(null) e Number('') são 0. Em coordenadas, esse "atalho" manda
      // toda câmera sem localização para 0,0 — Atlântico, perto da África.
      latitude: camera.latitude === null || camera.latitude === undefined || camera.latitude === ''
        ? null
        : Number.isFinite(Number(camera.latitude)) ? Number(camera.latitude) : null,
      longitude: camera.longitude === null || camera.longitude === undefined || camera.longitude === ''
        ? null
        : Number.isFinite(Number(camera.longitude)) ? Number(camera.longitude) : null,
      rtmpIngestPath: camera.rtmpIngestPath ?? null,
      updatedAt: typeof camera.updatedAt === 'string' ? camera.updatedAt : previous?.updatedAt,
      rtspPort: camera.rtspPort ?? 554,
      model: sourceMode === 'rtmp_push'
        ? `${formatCodec(camera.detectedVideoCodec ?? camera.streamVideoCodec)} / RTMP`
        : `${formatCodec(camera.detectedVideoCodec ?? camera.streamVideoCodec)}${camera.rtspPath ? ' / RTSP' : ''}`,
      status: mapCameraStatus(camera.status, camera.recordingEnabled, effectiveRecordingMode, runtime),
      fps: effectiveFps ?? 0,
      resolution: formatResolution(detectedStreamWidth, detectedStreamHeight),
      storage: effectiveRecordingMode === 'motion'
        ? `Por movimento · ${camera.effectiveRetentionDays ?? camera.retentionDays ?? 3} dias de retenção`
        : camera.recordingEnabled
          ? `${camera.effectiveRetentionDays ?? camera.retentionDays ?? 3} dias de retenção`
          : 'Gravação desabilitada',
      storageUsedBytes: Number(camera.storageUsedBytes ?? 0),
      storageLocalBytes: Number(camera.storageLocalBytes ?? 0),
      storageCloudBytes: Number(camera.storageCloudBytes ?? 0),
      lastEvent: lastEvent ?? previous?.lastEvent,
      // PTZ vem SONDADO da API (Camera.ptzCapable), não deduzido aqui.
      //
      // Isto era `Boolean(camera.onvifPath || camera.onvifProfileToken)`: ou
      // seja, "foi cadastrada por ONVIF" virava "tem PTZ", e a tela de controle
      // enchia de câmera fixa enquanto a que tem PTZ de verdade ficava de fora
      // por estar offline no cadastro.
      //
      // `null` na API significa "ainda não sondada", e aqui vira false — não
      // oferecer controle que talvez não exista é melhor que oferecer e falhar.
      // A varredura resolve o null sozinha no próximo ciclo de saúde.
      ptzCapable: camera.ptzCapable === true,
      ptzDetectado: camera.ptzCapable === true ? true : camera.ptzCapable === false ? false : null,
      hasAudio: Boolean(camera.audioEnabled),
      aiEnabled: camera.aiEnabled !== false,
      objectMode: camera.objectMode === 'sempre' || camera.objectMode === 'nunca' ? camera.objectMode : 'auto',
      aiObjectClasses: Array.isArray(camera.aiObjectClasses) ? camera.aiObjectClasses : [],
      aiSensitivity: camera.aiSensitivity === 'sensitive' || camera.aiSensitivity === 'precise'
        ? camera.aiSensitivity
        : 'balanced',
      aiConfidence: Number.isFinite(Number(camera.aiConfidence))
        ? Math.max(55, Math.min(90, Math.round(Number(camera.aiConfidence))))
        : camera.aiSensitivity === 'sensitive'
          ? 60
          : camera.aiSensitivity === 'precise'
            ? 78
            : 70,
      detectionZones: Array.isArray(camera.detectionZones) ? camera.detectionZones : [],
      alarmsEnabled: camera.alarmsEnabled !== false,
      enabled: camera.enabled !== false,
      isPrivate: camera.isPrivate === true,
      // canView vem do withCapabilities da API; ausente = assume permitido (retrocompat).
      canViewContent: camera.canView !== false,
      isOnline: camera.status === 'ONLINE',
      signalStrength: camera.status === 'ONLINE' ? 100 : 0,
      recordingMode: effectiveRecordingMode,
      retentionDays: camera.retentionDays ?? 7,
      effectiveRetentionDays: camera.effectiveRetentionDays ?? camera.retentionDays ?? 3,
      retentionFollowsGroup: camera.retentionFollowsGroup !== false,
      preferredRtspTransport: camera.preferredRtspTransport ?? 'tcp',
      preferredLiveProtocol: camera.preferredLiveProtocol ?? 'webrtc',
      rtspPath: camera.rtspPath ?? undefined,
      liveChannel: camera.liveChannel ?? null,
      liveSubtype: camera.liveSubtype ?? null,
      recordingChannel: camera.recordingChannel ?? null,
      recordingSubtype: camera.recordingSubtype ?? null,
      analyticsChannel: camera.analyticsChannel ?? null,
      analyticsSubtype: camera.analyticsSubtype ?? null,
      streamVideoCodec: camera.streamVideoCodec ?? undefined,
      streamWidth: configuredStreamWidth,
      streamHeight: configuredStreamHeight,
      streamFps: camera.streamFps ?? null,
      streamBitrateKbps: camera.streamBitrateKbps ?? null,
      recordingVideoCodec: camera.recordingVideoCodec ?? undefined,
      recordingWidth: camera.recordingWidth ?? null,
      recordingHeight: camera.recordingHeight ?? null,
      recordingFps: camera.recordingFps ?? null,
      recordingBitrateKbps: camera.recordingBitrateKbps ?? null,
      detectedVideoCodec: camera.detectedVideoCodec ?? undefined,
      detectedWidth: camera.detectedWidth ?? null,
      detectedHeight: camera.detectedHeight ?? null,
      detectedFps: camera.detectedFps ?? null,
      detectedBitrateKbps: camera.detectedBitrateKbps ?? null,
      lastMotion: lastEvent ?? previous?.lastMotion,
      thumbnailColor: previous?.thumbnailColor ?? THUMBNAIL_COLORS[index % THUMBNAIL_COLORS.length],
      recordingStatusDetail: runtime?.statusDetail ?? previous?.recordingStatusDetail,
      manualRecordingActive: runtime?.manualRecordingActive ?? previous?.manualRecordingActive,
      recordingStale: runtime?.stale ?? previous?.recordingStale ?? false,
      lastSegmentAt: runtime?.lastSegmentAt ?? previous?.lastSegmentAt ?? null,
      lastSegmentAgeSeconds: typeof runtime?.lastSegmentAgeSeconds === 'number'
        ? runtime.lastSegmentAgeSeconds
        : previous?.lastSegmentAgeSeconds ?? null,
    };
  });
}

function mapAlarmItems(rawAlarms: any[], cameras: Camera[]): Alarm[] {
  return rawAlarms.map((alarm: any) => ({
    id: alarm.id,
    name: alarm.title || `${alarm.type} — ${alarm.cameraName}`,
    type: alarm.type,
    status: alarm.status === 'RESOLVED' ? 'resolved' : alarm.status === 'ACKED' ? 'acknowledged' : 'active',
    priority: alarm.priority ?? (alarm.severity === 'CRITICAL' ? 'P1' : alarm.severity === 'WARNING' ? 'P2' : 'P4'),
    triggeredAt: alarm.occurredAt,
    acknowledgedAt: alarm.acknowledgedAt ?? undefined,
    acknowledgedBy: alarm.acknowledgedByUserName ?? undefined,
    cameraId: alarm.cameraId,
    zone: cameras.find((camera) => camera.id === alarm.cameraId)?.zone ?? 'Sem zona',
    description: alarm.message,
    notes: alarm.note ?? undefined,
    isSnoozed: Boolean(alarm.isSnoozed),
    snoozedUntil: alarm.snoozedUntil ?? undefined,
    transitionHistory: Array.isArray(alarm.transitionHistory) ? alarm.transitionHistory : [],
    notificationDelivery: Array.isArray(alarm.notificationDelivery) ? alarm.notificationDelivery : [],
    lastNotificationStatus: typeof alarm.lastNotificationStatus === 'string' ? alarm.lastNotificationStatus : undefined,
    occurrenceCount: typeof alarm.occurrenceCount === 'number' ? alarm.occurrenceCount : 1,
    lastOccurredAt: alarm.lastOccurredAt ?? alarm.occurredAt ?? undefined,
  }));
}

const API_URL = getApiBaseUrl();
const THUMBNAIL_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
const API_REQUEST_TIMEOUT_MS = 15_000;
const FULL_LOAD_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
let fullLoadRetryTimer: ReturnType<typeof setTimeout> | null = null;
let fullLoadRetryAttempt = 0;
let operationalFailureStreak = 0;

function clearFullLoadRetry() {
  if (fullLoadRetryTimer) clearTimeout(fullLoadRetryTimer);
  fullLoadRetryTimer = null;
  fullLoadRetryAttempt = 0;
  operationalFailureStreak = 0;
}

function scheduleFullLoadRetry() {
  if (fullLoadRetryTimer) return;
  const delay = FULL_LOAD_RETRY_DELAYS_MS[Math.min(fullLoadRetryAttempt, FULL_LOAD_RETRY_DELAYS_MS.length - 1)];
  fullLoadRetryAttempt += 1;
  fullLoadRetryTimer = setTimeout(() => {
    fullLoadRetryTimer = null;
    void useVmsDataStore.getState().load();
  }, delay);
}

function api() {
  const accessToken = useAuthStore.getState().accessToken;
  return axios.create({
    baseURL: API_URL,
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    timeout: API_REQUEST_TIMEOUT_MS,
  });
}

function mapRole(role: string): User['role'] {
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') return 'admin';
  if (role === 'OPERATOR') return 'operator';
  return 'viewer';
}

function mapSeverity(severity: string): VMSEvent['severity'] {
  if (severity === 'CRITICAL') return 'critical';
  if (severity === 'WARNING') return 'warning';
  return 'info';
}

function mapCameraStatus(
  status: string,
  recordingEnabled: boolean,
  recordingMode: Camera['recordingMode'],
  runtime?: RecordingRuntimeStatus,
): Camera['status'] {
  if (status === 'ONLINE') {
    // Em modo motion, recordingEnabled indica processo FFmpeg ativo, não se a
    // regra está armada. Exibir "Movimento" evita chamar uma câmera ociosa mas
    // armada de "gravação desabilitada".
    // `object` é armada igual a `motion` — cair no 'online' faria a lista
    // mostrar como ociosa uma câmera que está de guarda esperando pessoa.
    if (recordingMode === 'motion' || recordingMode === 'object') return 'motion';
    if (runtime?.isRecording ?? recordingEnabled) return 'recording';
    return 'online';
  }
  if (status === 'ERROR') return 'alarm';
  if (status === 'OFFLINE') return 'offline';
  if (status === 'UNKNOWN') return 'checking';
  return 'no_signal';
}

function cameraLayoutGridSize(count: number): SavedLayout['gridSize'] {
  if (count <= 1) return '1x1';
  if (count <= 4) return '2x2';
  if (count <= 9) return '3x3';
  return '4x4';
}

function formatResolution(width?: number | null, height?: number | null) {
  if (!width || !height) return '—';
  return `${width}x${height}`;
}

function formatCodec(codec?: string | null) {
  if (!codec) return 'Câmera IP';
  return codec.toUpperCase();
}

export const useVmsDataStore = create<VmsDataState>((set, get) => ({
  cameras: [],
  users: [],
  events: [],
  alarms: [],
  recordings: [],
  layouts: [],
  overview: null,
  system: null,
  auditLogs: [],
  operationsTimeline: [],
  isLoading: false,
  isRefreshing: false,
  loaded: false,
  error: null,
  stale: true,
  lastUpdatedAt: null,
  resourceErrors: {},
  load: async () => {
    const auth = useAuthStore.getState();
    if (!auth.accessToken) {
      clearFullLoadRetry();
      // NÃO ter token AGORA não prova que a sessão acabou.
      //
      // O access token vive só na memória e expira em 15 minutos; entre a
      // expiração e a renovação existe uma janela em que ele é nulo. Com a API
      // travada nesse instante, a renovação demora — e a janela vira segundos
      // ou minutos.
      //
      // Apagar as coleções aqui era o que ESVAZIAVA a tela: o operador via
      // "dados desatualizados", a lista de câmeras sumia, dava para navegar
      // entre abas em branco, e tudo voltava sozinho quando a renovação
      // completava. Nada disso era perda de sessão — era um buraco de token.
      //
      // Só limpa quando a sessão REALMENTE terminou (sem usuário). Havendo
      // usuário, o que está na tela continua valendo, marcado como
      // desatualizado: dado velho identificado é melhor que tela vazia.
      if (auth.user) {
        set({ isLoading: false, isRefreshing: false, stale: true });
        scheduleFullLoadRetry();
        return;
      }
      set({
        cameras: [], users: [], events: [], alarms: [], recordings: [], layouts: [],
        overview: null, system: null, auditLogs: [], operationsTimeline: [], loaded: false,
        isLoading: false, isRefreshing: false, stale: true, lastUpdatedAt: null, resourceErrors: {}, error: null,
      });
      return;
    }
    // Uma retentativa agendada pode coincidir com atualização manual. O fluxo
    // já em andamento decidirá se deve limpar ou reagendar quando terminar.
    if (get().isLoading) return;

    set({ isLoading: true, error: null });
    const client = api();
    const role = useAuthStore.getState().user?.role;
    // Saúde do host é deliberadamente restrita a administradores. Um
    // visualizador não precisa (nem deve tentar) consultar CPU, disco e
    // processos do servidor; 403 aqui não é falha operacional.
    const systemHealthRequest = role === 'admin'
      ? fetchResource<any>('saúde', client.get('/health/system'))
      : Promise.resolve({ data: null, error: null });
    const [camerasRes, usersRes, overviewRes, eventsRes, alarmsRes, recordingsRes, operationsTimelineRes, recordingStatusesRes, systemRes, auditRes] = await Promise.all([
      fetchResource<any[]>('câmeras', client.get('/cameras')),
      role === 'viewer' ? Promise.resolve({ data: [] as any[], error: null }) : fetchResource<any[]>('usuários', client.get('/users')),
      fetchResource<any>('resumo', client.get('/cameras/overview')),
      fetchResource<any>('eventos', client.get('/cameras/events-feed?limit=100')),
      fetchResource<any>('alarmes', client.get('/cameras/alarms?limit=100')),
      fetchResource<any>('gravações', client.get('/recordings?limit=100&sort=desc')),
      fetchResource<any>('linha operacional', client.get('/cameras/operations-timeline?limit=120')),
      fetchResource<any>('estado de gravação', client.get('/recordings/statuses')),
      systemHealthRequest,
      role === 'admin' ? fetchResource<any>('auditoria', client.get('/audit-logs?limit=100')) : Promise.resolve({ data: { items: [] }, error: null }),
    ]);

    const previous = get();
    const rawEvents = Array.isArray(eventsRes.data?.items) ? eventsRes.data.items : null;
    const runtimeStatuses = new Map<string, RecordingRuntimeStatus>(
      Array.isArray(recordingStatusesRes.data?.items)
        ? recordingStatusesRes.data.items.map((item: RecordingRuntimeStatus) => [item.cameraId, item] as const)
        : [],
    );
    const cameras = Array.isArray(camerasRes.data)
      ? mapCameraItems(camerasRes.data, rawEvents ?? [], runtimeStatuses, previous.cameras)
      : previous.cameras;
    const events = rawEvents ? mapEventItems(rawEvents) : previous.events;
    const rawAlarms = Array.isArray(alarmsRes.data?.items) ? alarmsRes.data.items : null;
    const alarms = rawAlarms ? mapAlarmItems(rawAlarms, cameras) : previous.alarms;
    const users: User[] = Array.isArray(usersRes.data)
      ? usersRes.data.map((user: any) => ({
          id: user.id, name: user.name, role: mapRole(user.role), username: user.username, email: user.email,
          badge: `USR-${user.id.slice(0, 6).toUpperCase()}`, lastLogin: user.updatedAt,
          shift: 'morning', active: Boolean(user.isActive),
        }))
      : previous.users;
    const recordings: RecordingItem[] = Array.isArray(recordingsRes.data?.items) ? recordingsRes.data.items : previous.recordings;
    const gridSize = cameraLayoutGridSize(cameras.length);
    const layouts: SavedLayout[] = cameras.length ? [{
      id: 'default-live-layout', name: 'Layout Atual', gridSize,
      cameraIds: cameras.map((camera) => camera.id),
      createdBy: useAuthStore.getState().user?.name ?? 'Sistema', lastUsed: new Date().toISOString(),
    }] : [];
    const namedResources = {
      cameras: camerasRes,
      users: usersRes,
      overview: overviewRes,
      events: eventsRes,
      alarms: alarmsRes,
      recordings: recordingsRes,
      operationsTimeline: operationsTimelineRes,
      recordingStatuses: recordingStatusesRes,
      system: systemRes,
      audit: auditRes,
    };
    const resourceErrors = Object.fromEntries(
      Object.entries(namedResources).filter(([, result]) => result.error).map(([name, result]) => [name, result.error as string]),
    );
    const criticalErrors = [camerasRes, overviewRes, eventsRes, alarmsRes, recordingStatusesRes, systemRes].filter((result) => result.error);
    const refreshedAt = new Date().toISOString();

    set({
      cameras, users, events, alarms, recordings, layouts,
      overview: overviewRes.data?.summary ?? previous.overview,
      system: systemRes.data ?? previous.system,
      auditLogs: Array.isArray(auditRes.data?.items) ? auditRes.data.items : previous.auditLogs,
      operationsTimeline: Array.isArray(operationsTimelineRes.data?.items) ? operationsTimelineRes.data.items : previous.operationsTimeline,
      isLoading: false, loaded: true,
      stale: criticalErrors.length > 0,
      lastUpdatedAt: criticalErrors.length ? previous.lastUpdatedAt : refreshedAt,
      resourceErrors,
      error: criticalErrors.length ? criticalErrors.map((result) => result.error).filter(Boolean).join(' · ') : null,
    });
    if (Object.keys(resourceErrors).length > 0) scheduleFullLoadRetry();
    else clearFullLoadRetry();
  },
  refreshOperational: async () => {
    if (!useAuthStore.getState().accessToken || get().isRefreshing || get().isLoading) return;
    set({ isRefreshing: true });
    const client = api();
    const role = useAuthStore.getState().user?.role;
    // Ver comentário equivalente em load(): não transformar a permissão
    // correta de um visualizador em alerta de dados desatualizados.
    const systemHealthRequest = role === 'admin'
      ? fetchResource<any>('saúde', client.get('/health/system'))
      : Promise.resolve({ data: null, error: null });
    const [camerasRes, overviewRes, eventsRes, alarmsRes, recordingStatusesRes, systemRes] = await Promise.all([
      fetchResource<any[]>('câmeras', client.get('/cameras')),
      fetchResource<any>('resumo', client.get('/cameras/overview')),
      fetchResource<any>('eventos', client.get('/cameras/events-feed?limit=100')),
      fetchResource<any>('alarmes', client.get('/cameras/alarms?limit=100')),
      fetchResource<any>('estado de gravação', client.get('/recordings/statuses')),
      systemHealthRequest,
    ]);
    const previous = get();
    const rawEvents = Array.isArray(eventsRes.data?.items) ? eventsRes.data.items : null;
    const runtimeStatuses = new Map<string, RecordingRuntimeStatus>(
      Array.isArray(recordingStatusesRes.data?.items)
        ? recordingStatusesRes.data.items.map((item: RecordingRuntimeStatus) => [item.cameraId, item] as const)
        : [],
    );
    const cameras = Array.isArray(camerasRes.data)
      ? mapCameraItems(camerasRes.data, rawEvents ?? [], runtimeStatuses, previous.cameras)
      : previous.cameras;
    const events = rawEvents ? mapEventItems(rawEvents) : previous.events;
    const rawAlarms = Array.isArray(alarmsRes.data?.items) ? alarmsRes.data.items : null;
    const alarms = rawAlarms ? mapAlarmItems(rawAlarms, cameras) : previous.alarms;
    const resources = {
      cameras: camerasRes,
      overview: overviewRes,
      events: eventsRes,
      alarms: alarmsRes,
      recordingStatuses: recordingStatusesRes,
      system: systemRes,
    };
    const resourceErrors = Object.fromEntries(
      Object.entries(resources).filter(([, result]) => result.error).map(([name, result]) => [name, result.error as string]),
    );
    const criticalErrors = [camerasRes, overviewRes, eventsRes, alarmsRes, recordingStatusesRes, systemRes].filter((result) => result.error);
    operationalFailureStreak = criticalErrors.length > 0 ? operationalFailureStreak + 1 : 0;
    // Um único ciclo pode coincidir com rotação do token, troca de rede ou um
    // deploy de poucos segundos. Os dados anteriores continuam válidos e não
    // justificam assustar o operador com uma faixa amarela. A primeira falha
    // agenda a recuperação; só uma falha consecutiva confirma desatualização.
    const confirmedStale = criticalErrors.length > 0
      && (previous.stale || operationalFailureStreak >= 2);
    set({
      cameras, events, alarms,
      overview: overviewRes.data?.summary ?? previous.overview,
      system: systemRes.data ?? previous.system,
      isRefreshing: false,
      stale: confirmedStale,
      lastUpdatedAt: criticalErrors.length ? previous.lastUpdatedAt : new Date().toISOString(),
      resourceErrors: confirmedStale ? resourceErrors : {},
      error: confirmedStale ? criticalErrors.map((result) => result.error).filter(Boolean).join(' · ') : null,
    });
    // Qualquer falha operacional depois de um deploy dispara uma recarga
    // COMPLETA. Assim usuários, gravações, auditoria e timeline também voltam;
    // o polling leve sozinho só recuperava seis recursos e deixava telas vazias.
    if (criticalErrors.length > 0) scheduleFullLoadRetry();
    else clearFullLoadRetry();
  },
  updateUserActive: async (id, active) => {
    await api().patch(`/users/${id}`, { isActive: active });
    set((state) => ({
      users: state.users.map((user) => (user.id === id ? { ...user, active } : user)),
    }));
  },
  acknowledgeAlarm: async (id, note) => {
    await api().post(`/cameras/alarms/${id}/ack`, { note });
    set((state) => ({
      alarms: state.alarms.map((alarm) =>
        alarm.id === id
          ? { ...alarm, status: 'acknowledged', acknowledgedAt: new Date().toISOString(), acknowledgedBy: useAuthStore.getState().user?.name ?? 'Operador' }
          : alarm,
      ),
    }));
  },
  resolveAlarm: async (id, note) => {
    await api().post(`/cameras/alarms/${id}/resolve`, { note });
    set((state) => ({
      alarms: state.alarms.map((alarm) => (alarm.id === id ? { ...alarm, status: 'resolved', notes: note ?? alarm.notes } : alarm)),
    }));
  },
  snoozeAlarm: async (id, minutes, note) => {
    await api().post(`/cameras/alarms/${id}/snooze`, { minutes: minutes ?? 15, note });
    await get().load();
  },
  unsnoozeAlarm: async (id, note) => {
    await api().post(`/cameras/alarms/${id}/unsnooze`, { note });
    await get().load();
  },
  bulkAlarmAction: async (action, eventIds, opts) => {
    await api().post('/cameras/alarms/bulk', { action, eventIds, note: opts?.note, minutes: opts?.minutes });
    await get().load();
  },
  addNote: (id, note) => {
    set((state) => ({
      alarms: state.alarms.map((alarm) => (alarm.id === id ? { ...alarm, notes: alarm.notes ? `${alarm.notes}\n${note}` : note } : alarm)),
    }));
  },
}));
