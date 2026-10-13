import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../common/crypto/crypto.service';
import { envNumber } from '../common/config/env-number.helper';
import { spawnWithSecretUrl } from '../common/process/secret-url-process.helper';
import {
  ingestProfilePathCandidates,
  ingestPathNames,
  isAcceptableIngestPath,
  isValidIngestKey,
  normalizeIngestPath,
} from './helpers/rtmp-ingest.helper';

export type RtmpStreamMetadata = {
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
};

export type ResolvedRtmpIngestSource = {
  pathName: string;
  sourceUrl: string;
  ready: boolean;
  stalled: boolean;
  bytesReceived: number | null;
  tracks: string[];
  metadata: RtmpStreamMetadata;
};

type PushCameraSource = {
  id?: string;
  rtmpIngestPath?: string | null;
  rtmpIngestKeyEncrypted?: string | null;
  detectedVideoCodec?: string | null;
  streamVideoCodec?: string | null;
  detectedWidth?: number | null;
  detectedHeight?: number | null;
  detectedFps?: number | null;
  detectedBitrateKbps?: number | null;
};

type RuntimePath = {
  ready: boolean;
  bytesReceived: number | null;
  tracks: string[];
  codec: string | null;
  stalled: boolean;
  bitrateKbps: number | null;
};

type ByteSample = {
  bytes: number;
  sampledAt: number;
  lastProgressAt: number;
  bitrateKbps: number | null;
};

// SRS confirma a publicação antes de o MediaMTX necessariamente expor o path
// interno. Essa pequena janela é normal em uma entrada RTMP e não deve virar
// "sem vídeo" no primeiro acesso do operador.
const READY_RECHECK_DELAYS_MS = [250, 750] as const;

/**
 * Resolve a origem canônica de câmeras que PUBLICAM por RTMP.
 *
 * Esta classe mora no CamerasModule para ser compartilhada por live, gravação,
 * IA e health sem criar um ciclo CameraStream <-> Recordings. Todos recebem a
 * mesma URL RTSP interna do MediaMTX e, portanto, nunca tentam discar 0.0.0.0.
 */
@Injectable()
export class RtmpIngestSourceService {
  private readonly logger = new Logger(RtmpIngestSourceService.name);
  private readonly samples = new Map<string, ByteSample>();
  private readonly metadataCache = new Map<string, { value: RtmpStreamMetadata; at: number }>();

  constructor(
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
  ) {}

  private stallThresholdMs() {
    return envNumber('RTMP_STALL_THRESHOLD_SECONDS', 20, {
      min: 10,
      max: 300,
      integer: true,
      onInvalid: (message) => this.logger.warn(message),
    }) * 1000;
  }

  private mediaMtxCredentials() {
    const user = (this.configService.get<string>('mediaMtxApiUser') ?? '').trim();
    const pass = (this.configService.get<string>('mediaMtxApiPass') ?? '').trim();
    if (!user || !pass) {
      throw new Error('Credenciais internas do MediaMTX não configuradas.');
    }
    return { user, pass };
  }

  private async apiGet(path: string): Promise<{ status: number; body: string }> {
    const base = (this.configService.get<string>('mediaMtxApiBaseUrl') ?? 'http://mediamtx:9997').replace(/\/+$/, '');
    const { user, pass } = this.mediaMtxCredentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` },
        signal: controller.signal,
      });
      return { status: response.status, body: await response.text().catch(() => '') };
    } finally {
      clearTimeout(timer);
    }
  }

  buildInternalRtspUrl(pathName: string) {
    const base = (this.configService.get<string>('mediaMtxRtspInternalUrl') ?? 'rtsp://mediamtx:8554').replace(/\/+$/, '');
    const { user, pass } = this.mediaMtxCredentials();
    const parsed = new URL(`${base}/${encodeURIComponent(pathName)}`);
    if (!parsed.username) parsed.username = user;
    if (!parsed.password) parsed.password = pass;
    return parsed.toString();
  }

  private candidatePaths(camera: PushCameraSource): string[] {
    if (isAcceptableIngestPath(camera.rtmpIngestPath)) {
      return ingestProfilePathCandidates(normalizeIngestPath(camera.rtmpIngestPath));
    }
    if (!camera.rtmpIngestKeyEncrypted) return [];
    try {
      const key = this.cryptoService.decrypt(camera.rtmpIngestKeyEncrypted);
      return isValidIngestKey(key) ? ingestPathNames(key) : [];
    } catch {
      return [];
    }
  }

  /** Stop only publishers belonging to this camera; credentials never leave memory. */
  async pausePublishers(camera: PushCameraSource) {
    const candidates = new Set(this.candidatePaths(camera));
    if (!candidates.size) return;
    const { user, pass } = this.mediaMtxCredentials();
    const mediaBase = (this.configService.get<string>('mediaMtxApiBaseUrl') ?? 'http://mediamtx:9997').replace(/\/+$/, '');
    const headers = { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
    const routes: Record<string, string> = { rtmpConn: 'rtmpconns', rtspSession: 'rtspsessions', srtConn: 'srtconns' };
    for (const path of candidates) {
      const runtime = await this.apiGet(`/v3/paths/get/${encodeURIComponent(path)}`);
      if (runtime.status === 404) continue;
      if (runtime.status !== 200) throw new Error('Aguardando confirmação da ingestão.');
      const source = JSON.parse(runtime.body).source;
      if (source?.id && routes[source.type]) {
        const response = await fetch(`${mediaBase}/v3/${routes[source.type]}/kick/${encodeURIComponent(source.id)}`, { method: 'POST', headers, signal: AbortSignal.timeout(5000) });
        if (!response.ok && response.status !== 404) throw new Error('Aguardando parada da ingestão.');
      }
    }
    // The legacy RTMP translator can keep its forward alive after MediaMTX is kicked.
    const base = 'http://rtmp-callback:8080/discovery-srs';
    const token = this.configService.get<string>('mediaMtxAuthCallbackToken') ?? '';
    if (token.length < 32) throw new Error('Controle da ingestão não configurado.');
    const controlHeaders = { 'X-Discovery-Token': token };
    for (let start = 0; start < 1_000_000; start += 1000) {
      const response = await fetch(`${base}/clients/?start=${start}&count=1000`, { headers: controlHeaders, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Aguardando confirmação do tradutor RTMP.');
      const result: any = await response.json();
      if (result.code !== 0 || !Array.isArray(result.clients)) throw new Error('Resposta inválida do tradutor RTMP.');
      for (const client of result.clients) {
        const path = String(client.url ?? '').replace(/^\//, '').replace(/^__defaultVhost__\//, '').split('?')[0];
        if (!candidates.has(path) || !client.id) continue;
        const stopped = await fetch(`${base}/clients/${encodeURIComponent(client.id)}`, { method: 'DELETE', headers: controlHeaders, signal: AbortSignal.timeout(5000) });
        if (!stopped.ok && stopped.status !== 404) throw new Error('Aguardando parada do publicador RTMP.');
        if (stopped.ok && (await stopped.json() as any).code !== 0) throw new Error('Aguardando confirmação da parada RTMP.');
      }
      if (result.clients.length < 1000) return;
    }
    throw new Error('Quantidade de publicadores RTMP excedida.');
  }

  private normalizeTracks(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return input
      .map((track) => {
        if (typeof track === 'string') return track.trim();
        if (track && typeof track === 'object') {
          const value = (track as Record<string, unknown>).codec
            ?? (track as Record<string, unknown>).type
            ?? (track as Record<string, unknown>).name;
          return typeof value === 'string' ? value.trim() : '';
        }
        return '';
      })
      .filter(Boolean);
  }

  private codecFromTracks(tracks: string[]): string | null {
    const joined = tracks.join(' ').toLowerCase();
    if (/h\.?265|hevc|hvc1/.test(joined)) return 'h265';
    if (/h\.?264|avc/.test(joined)) return 'h264';
    if (/\bav1\b/.test(joined)) return 'av1';
    if (/\bvp9\b/.test(joined)) return 'vp9';
    if (/\bvp8\b/.test(joined)) return 'vp8';
    return null;
  }

  private sampleProgress(pathName: string, ready: boolean, bytesReceived: number | null) {
    if (!ready || bytesReceived == null) {
      this.samples.delete(pathName);
      return { stalled: false, bitrateKbps: null as number | null };
    }
    const now = Date.now();
    const previous = this.samples.get(pathName);
    if (!previous) {
      this.samples.set(pathName, {
        bytes: bytesReceived,
        sampledAt: now,
        lastProgressAt: now,
        bitrateKbps: null,
      });
      return { stalled: false, bitrateKbps: null as number | null };
    }

    let lastProgressAt = previous.lastProgressAt;
    let bitrateKbps = previous.bitrateKbps;
    if (bytesReceived !== previous.bytes) {
      const elapsedMs = Math.max(1, now - previous.sampledAt);
      // Contador menor significa nova sessão/restart; é progresso, mas não gera
      // bitrate negativo nem mistura duas conexões diferentes.
      bitrateKbps = bytesReceived > previous.bytes
        ? Math.max(1, Math.round(((bytesReceived - previous.bytes) * 8) / elapsedMs))
        : null;
      lastProgressAt = now;
    }
    this.samples.set(pathName, { bytes: bytesReceived, sampledAt: now, lastProgressAt, bitrateKbps });
    return { stalled: now - lastProgressAt >= this.stallThresholdMs(), bitrateKbps };
  }

  async getRuntime(pathName: string): Promise<RuntimePath> {
    const response = await this.apiGet(`/v3/paths/get/${encodeURIComponent(pathName)}`);
    if (response.status === 404) {
      this.samples.delete(pathName);
      return { ready: false, bytesReceived: null, tracks: [], codec: null, stalled: false, bitrateKbps: null };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MediaMTX respondeu ${response.status} ao consultar a ingestão RTMP.`);
    }
    const data = JSON.parse(response.body || '{}') as Record<string, unknown>;
    const ready = data.ready === true;
    const bytesValue = Number(data.bytesReceived);
    const bytesReceived = Number.isFinite(bytesValue) ? bytesValue : null;
    const tracks = this.normalizeTracks(data.tracks);
    const progress = this.sampleProgress(pathName, ready, bytesReceived);
    return {
      ready,
      bytesReceived,
      tracks,
      codec: this.codecFromTracks(tracks),
      stalled: progress.stalled,
      bitrateKbps: progress.bitrateKbps,
    };
  }

  async resolve(camera: PushCameraSource, options: { requireReady?: boolean } = {}): Promise<ResolvedRtmpIngestSource> {
    const candidates = this.candidatePaths(camera);
    if (!candidates.length) {
      throw new Error('Câmera RTMP ainda não tem chave nem equipamento vinculado.');
    }

    let selectedPath = candidates[0];
    let selectedRuntime: RuntimePath | null = null;
    let stalledCandidate: { pathName: string; runtime: RuntimePath } | null = null;
    for (const pathName of candidates) {
      const runtime = await this.getRuntime(pathName);
      if (!selectedRuntime) {
        selectedPath = pathName;
        selectedRuntime = runtime;
      }
      if (runtime.ready && !runtime.stalled) {
        selectedPath = pathName;
        selectedRuntime = runtime;
        break;
      }
      if (runtime.ready && !stalledCandidate) {
        stalledCandidate = { pathName, runtime };
      }
    }
    // Um perfil conectado mas sem bytes é diagnóstico melhor do que "offline"
    // quando nenhum irmão saudável existe. Ele nunca vence um secundário vivo.
    if (selectedRuntime && !selectedRuntime.ready && stalledCandidate) {
      selectedPath = stalledCandidate.pathName;
      selectedRuntime = stalledCandidate.runtime;
    }
    selectedRuntime ??= {
      ready: false,
      bytesReceived: null,
      tracks: [],
      codec: null,
      stalled: false,
      bitrateKbps: null,
    };
    if (options.requireReady && (!selectedRuntime.ready || selectedRuntime.stalled)) {
      // Reconsulta todos os aliases por um intervalo curto e limitado. Não é
      // polling infinito: ela só absorve a propagação SRS -> MediaMTX no exato
      // momento em que uma câmera RTMP começa a publicar.
      for (const delayMs of READY_RECHECK_DELAYS_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        for (const pathName of candidates) {
          const runtime = await this.getRuntime(pathName);
          if (!runtime.ready || runtime.stalled) continue;
          selectedPath = pathName;
          selectedRuntime = runtime;
          break;
        }
        if (selectedRuntime.ready && !selectedRuntime.stalled) break;
      }
    }
    if (options.requireReady && (!selectedRuntime.ready || selectedRuntime.stalled)) {
      throw new Error(selectedRuntime.stalled
        ? 'A publicação RTMP está conectada, mas parou de entregar quadros.'
        : 'Câmera RTMP ainda não está publicando vídeo.');
    }

    const knownCodec = selectedRuntime.codec
      ?? String(camera.detectedVideoCodec ?? camera.streamVideoCodec ?? '').trim().toLowerCase()
      ?? null;
    const cached = this.metadataCache.get(selectedPath)?.value;
    return {
      pathName: selectedPath,
      sourceUrl: this.buildInternalRtspUrl(selectedPath),
      ready: selectedRuntime.ready,
      stalled: selectedRuntime.stalled,
      bytesReceived: selectedRuntime.bytesReceived,
      tracks: selectedRuntime.tracks,
      metadata: {
        codec: knownCodec || cached?.codec || null,
        width: cached?.width ?? camera.detectedWidth ?? null,
        height: cached?.height ?? camera.detectedHeight ?? null,
        fps: cached?.fps ?? camera.detectedFps ?? null,
        bitrateKbps: selectedRuntime.bitrateKbps ?? cached?.bitrateKbps ?? camera.detectedBitrateKbps ?? null,
      },
    };
  }

  async probeMetadata(sourceUrl: string, cacheKey: string): Promise<RtmpStreamMetadata | null> {
    const cached = this.metadataCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
    const result = await new Promise<RtmpStreamMetadata | null>((resolve) => {
      let settled = false;
      const finish = (value: RtmpStreamMetadata | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const proc = spawnWithSecretUrl('ffprobe', [
        '-v', 'error',
        '-rtsp_transport', 'tcp',
        '-timeout', '5000000',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,bit_rate:format=bit_rate',
        '-of', 'json',
        sourceUrl,
      ], sourceUrl);
      let stdout = '';
      proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* processo já terminou */ }
        finish(null);
      }, 8_000);
      timer.unref();
      proc.on('error', () => { clearTimeout(timer); finish(null); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return finish(null);
        try {
          const payload = JSON.parse(stdout) as Record<string, any>;
          const stream = Array.isArray(payload.streams) ? payload.streams[0] : null;
          if (!stream) return finish(null);
          const rate = String(stream.avg_frame_rate ?? '').split('/').map(Number);
          const fps = rate.length === 2 && Number.isFinite(rate[0]) && Number.isFinite(rate[1]) && rate[1] > 0
            ? Math.max(1, Math.round(rate[0] / rate[1]))
            : null;
          const bitrate = Number(stream.bit_rate ?? payload.format?.bit_rate);
          finish({
            codec: String(stream.codec_name ?? '').trim().toLowerCase() || null,
            width: Number.isFinite(Number(stream.width)) ? Number(stream.width) : null,
            height: Number.isFinite(Number(stream.height)) ? Number(stream.height) : null,
            fps,
            bitrateKbps: Number.isFinite(bitrate) && bitrate > 0 ? Math.max(1, Math.round(bitrate / 1000)) : null,
          });
        } catch {
          finish(null);
        }
      });
    });
    if (result) this.metadataCache.set(cacheKey, { value: result, at: Date.now() });
    return result;
  }
}
