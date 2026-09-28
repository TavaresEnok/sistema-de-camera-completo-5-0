import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CamerasService } from '../cameras/cameras.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { buildRtspUrl, resolveRecordingRtspProfile } from '../cameras/helpers/rtsp-url.helper';
import { isPushSourced } from '../cameras/helpers/rtmp-ingest.helper';
import { RtmpIngestSourceService } from '../cameras/rtmp-ingest-source.service';
import { spawnWithSecretUrl } from '../common/process/secret-url-process.helper';

type ClipState = {
  clipId: string;
  cameraId: string;
  userId: string;
  filePath: string;   // MP4 final servido no download
  recordPath: string; // .ts onde o ffmpeg grava (sempre remuxado p/ MP4)
  proc: ChildProcess | null;
  startedAt: number;
  stderrTail: string;
  exited: boolean;
  exitCode: number | null;
  autoStop?: NodeJS.Timeout;
  expiresAt: number;
  durationMs?: number;
};

/**
 * Gravação de CLIPE sob demanda (exato do start ao stop), para "gravar no
 * celular" no app. Diferente da gravação contínua por segmentos: aqui um ffmpeg
 * dedicado grava a câmera com `-c copy` (SEM transcode = baixa CPU) num arquivo
 * temporário; o stop finaliza o MP4 (parada graciosa via 'q' → moov/faststart
 * válidos) e o app baixa o arquivo. Travas: teto de duração, limite de clipes
 * simultâneos e faxina periódica (nunca deixa ffmpeg/arquivo órfão).
 */
@Injectable()
export class ClipCaptureService {
  private readonly logger = new Logger(ClipCaptureService.name);
  private readonly clips = new Map<string, ClipState>();
  private pendingStarts = 0;
  private readonly finalizations = new Map<string, Promise<{ ok: boolean; sizeBytes: number; durationMs: number }>>();
  private readonly dir: string;
  private readonly maxMs: number;
  private readonly maxConcurrent: number;
  private readonly ttlMs = 24 * 60 * 60 * 1000;
  private ffmpegOk: boolean | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly camerasService: CamerasService,
    private readonly cryptoService: CryptoService,
    private readonly rtmpIngestSource: RtmpIngestSourceService,
  ) {
    this.dir = path.join(this.configService.get<string>('recordingsRoot') ?? './storage/recordings', '.mobile-clips');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.maxMs = Number(this.configService.get<number>('clipMaxSeconds') ?? 300) * 1000; // 5min padrão
    this.maxConcurrent = Number(this.configService.get<number>('clipMaxConcurrent') ?? 3);
    this.restore();
    setInterval(() => this.sweep(), 60_000).unref?.();
  }

  private checkFfmpeg(): boolean {
    if (this.ffmpegOk === null) this.ffmpegOk = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 3000 }).status === 0;
    return this.ffmpegOk;
  }

  private activeCount(): number {
    let n = 0;
    for (const c of this.clips.values()) if (!c.exited) n += 1;
    return n;
  }

  /**
   * Resolve a entrada real do clipe sem confundir o marcador de uma câmera
   * push (`0.0.0.0`) com um endereço RTSP alcançável.
   *
   * RTMP chega primeiro ao MediaMTX e é consumido pela URL RTSP INTERNA já
   * autenticada. RTSP pull conserva exatamente o caminho anterior. Exigir a
   * publicação pronta aqui evita criar um clipe vazio e devolver sucesso falso
   * para o aplicativo quando a câmera RTMP está desconectada.
   */
  private async resolveClipInput(
    camera: Awaited<ReturnType<CamerasService['getCameraOrThrow']>>,
  ): Promise<{ url: string; transport: string }> {
    if (isPushSourced(camera)) {
      try {
        const source = await this.rtmpIngestSource.resolve(camera, { requireReady: true });
        return { url: source.sourceUrl, transport: 'tcp' };
      } catch (error) {
        throw new ServiceUnavailableException(
          error instanceof Error && error.message
            ? error.message
            : 'Câmera RTMP ainda não está publicando vídeo.',
        );
      }
    }

    const password = this.cryptoService.decrypt(camera.passwordEncrypted);
    const profile = resolveRecordingRtspProfile(camera);
    return {
      url: buildRtspUrl({
        username: camera.username,
        password,
        ip: camera.ip,
        rtspPort: camera.rtspPort,
        rtspPath: camera.rtspPath ?? undefined,
        channel: profile.channel,
        subtype: profile.subtype,
      }),
      transport: camera.preferredRtspTransport
        ?? this.configService.get<string>('ffmpegRtspTransport')
        ?? 'tcp',
    };
  }

  async start(cameraId: string, userId: string): Promise<{ clipId: string }> {
    if (!this.checkFfmpeg()) throw new ServiceUnavailableException('FFmpeg não está instalado no servidor.');
    if (this.activeCount() + this.pendingStarts >= this.maxConcurrent) {
      throw new ServiceUnavailableException('Muitas gravações de clipe em andamento. Tente novamente em instantes.');
    }
    this.pendingStarts++;
    try {
    const camera = await this.camerasService.getCameraOrThrow(cameraId);
    const input = await this.resolveClipInput(camera);
    const rtsp = input.url;
    const transport = input.transport;
    const clipId = randomUUID();
    const maxSeconds = Math.ceil(this.maxMs / 1000);
    // SEM transcode (cópia do codec original) = instantâneo, CPU quase zero,
    // qualidade máxima. SEMPRE gravamos em MPEG-TS (não MP4 direto) por 2 motivos:
    //  1) HEVC: gravar direto em MP4 com `-c:v copy` gera arquivo QUEBRADO
    //     (VPS/SPS/PPS não entram no hvcC ao conectar no meio do GOP) — testado.
    //     No TS os parâmetros ficam in-band; o remux TS→MP4 os extrai p/ o hvcC.
    //  2) O TS é formato de streaming: finaliza limpo com qualquer parada (q,
    //     SIGINT, até SIGKILL), sem depender da 2ª passada do `+faststart` do MP4.
    // O remux (rápido, sem re-encode) descobre o codec REAL do TS e só marca hvc1
    // se for HEVC — assim não confiamos no rótulo do banco (que pode estar errado:
    // câmera H.264 rotulada como h265 quebraria com -tag:v hvc1).
    const filePath = path.join(this.dir, `${clipId}.mp4`);
    const recordPath = path.join(this.dir, `${clipId}.ts`);
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', transport,
      '-i', rtsp,
      '-t', String(maxSeconds), // teto de segurança (auto-encerra)
      '-c:v', 'copy',
      '-c:a', 'aac', // PCM/G.711 não entra em MP4/TS; AAC é barato e universal
      '-f', 'mpegts', '-y', recordPath,
    ];
    const proc = spawnWithSecretUrl(
      'ffmpeg',
      args,
      rtsp,
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    const state: ClipState = {
      clipId, cameraId, userId, filePath, recordPath, proc,
      startedAt: Date.now(), stderrTail: '', exited: false, exitCode: null,
      expiresAt: Date.now() + this.maxMs + this.ttlMs,
      autoStop: setTimeout(() => { void this.stop(clipId, userId).catch(() => undefined); }, this.maxMs + 2000),
    };
    // Sanitiza JÁ AQUI (como recording-process-manager:843): o stderr do FFmpeg imprime a
    // URL de entrada inteira ("Error opening input file rtsp://user:senha@...") e este
    // stderrTail é devolvido ao cliente numa BadRequestException lá no stop(). Sem isto,
    // um VIEWER pedindo clipe de câmera offline recebia a SENHA da câmera na resposta.
    proc.stderr?.on('data', (b: Buffer) => {
      state.stderrTail = sanitizeSensitiveText(state.stderrTail + b.toString()).slice(-1000);
    });
    proc.on('close', (code) => { state.exited = true; state.exitCode = code; });
    proc.on('error', (e) => { state.exited = true; this.logger.error(`ffmpeg clip ${clipId}: ${sanitizeSensitiveText(e)}`); });
    this.clips.set(clipId, state);
    try { this.persist(state); } catch (error) { this.cleanup(clipId); throw error; }
    this.logger.log(`clip start ${clipId} camera=${cameraId} user=${userId}`);
    return { clipId };
    } finally { this.pendingStarts--; }
  }

  async stop(clipId: string, userId: string): Promise<{ ok: boolean; sizeBytes: number; durationMs: number }> {
    const st = this.clips.get(clipId);
    if (!st || st.userId !== userId) throw new NotFoundException('Clipe não encontrado.');
    const pending = this.finalizations.get(clipId);
    if (pending) return pending;
    const task = this.finalize(st).finally(() => this.finalizations.delete(clipId));
    this.finalizations.set(clipId, task);
    return task;
  }

  private async finalize(st: ClipState): Promise<{ ok: boolean; sizeBytes: number; durationMs: number }> {
    const clipId = st.clipId;
    clearTimeout(st.autoStop);
    if (!st.exited) {
      // Parada graciosa: 'q' faz o ffmpeg fechar o container (moov/faststart OK).
      try { st.proc?.stdin?.write('q'); } catch { /* ignore */ }
      const closed = await this.waitExit(st, 8000);
      if (!closed) { try { st.proc?.kill('SIGINT'); } catch { /* */ } await this.waitExit(st, 4000); }
      if (!st.exited) {
        try { st.proc?.kill('SIGKILL'); } catch { /* */ }
        if (!await this.waitExit(st, 2000)) throw new ServiceUnavailableException('O clipe ainda está sendo finalizado. Tente novamente.');
      }
    }
    // Remuxa o TS gravado → MP4 (cópia, sem transcode). É aqui que, no HEVC, os
    // parâmetros do vídeo entram no hvcC, deixando o arquivo tocável no celular.
    let tsBytes = 0;
    try { tsBytes = fs.statSync(st.recordPath).size; } catch { /* */ }
    if (tsBytes > 0) {
      const temporary = `${st.filePath}.partial`;
      const valid = await this.remux(st.recordPath, temporary);
      if (!valid || !fs.existsSync(temporary) || fs.statSync(temporary).size <= 1024) {
        try { fs.rmSync(temporary, { force: true }); } catch { /* original preservado */ }
        throw new ServiceUnavailableException('Não foi possível finalizar o clipe. O original foi preservado para nova tentativa.');
      }
      fs.renameSync(temporary, st.filePath);
      try { fs.rmSync(st.recordPath, { force: true }); } catch { /* ignore */ }
    }
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(st.filePath).size; } catch { /* */ }
    const durationMs = st.durationMs ?? Math.min(this.maxMs, Date.now() - st.startedAt);
    if (sizeBytes <= 0) {
      this.cleanup(clipId);
      // Dupla camada: o stderrTail já entra sanitizado, mas esta message vai direto no
      // corpo da resposta (http-exception.filter serializa o getResponse() verbatim).
      throw new BadRequestException(
        `Não foi possível gravar o clipe (câmera indisponível?). ${sanitizeSensitiveText(st.stderrTail).trim().slice(0, 200)}`,
      );
    }
    st.durationMs = durationMs;
    this.persist(st);
    return { ok: true, sizeBytes, durationMs };
  }

  private waitExit(st: ClipState, timeoutMs: number): Promise<boolean> {
    if (st.exited || !st.proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(st.exited), timeoutMs);
      st.proc?.once('close', () => { clearTimeout(t); resolve(true); });
    });
  }

  // Remux TS→MP4 SEM transcode (cópia). Rápido (~centenas de ms), não re-encoda.
  // Descobre o codec REAL gravado (não confia no rótulo do banco): só o HEVC leva
  // `-tag:v hvc1` (jeito que os players do celular abrem); H.264 usa o tag padrão
  // (avc1) — forçar hvc1 num H.264 gera arquivo quebrado/vazio.
  private probeCodec(src: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', src,
      ], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 }, (error, stdout) => {
        if (error || !stdout.trim()) reject(error ?? new Error('Vídeo inválido.'));
        else resolve(stdout.trim());
      });
    });
  }

  private async remux(src: string, dest: string): Promise<boolean> {
    let codec: string;
    try { codec = await this.probeCodec(src); } catch { return false; }
    const isHevc = /hevc|265/i.test(codec);
    const converted = await new Promise<boolean>((resolve) => {
      const p = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', src,
        '-c:v', 'copy', '-c:a', 'copy',
        ...(isHevc ? ['-tag:v', 'hvc1'] : []),
        '-movflags', '+faststart',
        '-f', 'mp4', '-y', dest,
      ], { stdio: 'ignore' });
      let timedOut = false;
      const t = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch { /* */ } }, 15000);
      p.on('close', (code) => { clearTimeout(t); resolve(!timedOut && code === 0); });
      p.on('error', () => { clearTimeout(t); resolve(false); });
    });
    if (!converted) return false;
    try { return Boolean(await this.probeCodec(dest)); } catch { return false; }
  }

  /** Caminho do arquivo do clipe SE existir e for do usuário (para download). */
  getClipFile(clipId: string, userId: string): string {
    const st = this.clips.get(clipId);
    if (!st || st.userId !== userId || !fs.existsSync(st.filePath)) throw new NotFoundException('Clipe não encontrado.');
    return st.filePath;
  }

  cleanup(clipId: string) {
    const st = this.clips.get(clipId);
    if (!st) return;
    clearTimeout(st.autoStop);
    if (!st.exited) { try { st.proc?.kill('SIGKILL'); } catch { /* */ } }
    try { fs.rmSync(st.filePath, { force: true }); } catch { /* */ }
    if (st.recordPath !== st.filePath) { try { fs.rmSync(st.recordPath, { force: true }); } catch { /* */ } }
    this.clips.delete(clipId);
    try { fs.rmSync(path.join(this.dir, `${clipId}.json`), { force: true }); } catch { /* retry on restart */ }
  }

  private sweep() {
    const now = Date.now();
    for (const [id, st] of this.clips) {
      if (now > st.expiresAt && !this.finalizations.has(id)) this.cleanup(id);
    }
  }

  getCameraId(clipId: string, userId: string): string {
    const st = this.clips.get(clipId);
    if (!st || st.userId !== userId) throw new NotFoundException('Clipe indisponível ou expirado.');
    return st.cameraId;
  }

  private persist(st: ClipState) {
    const target = path.join(this.dir, `${st.clipId}.json`);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({
      clipId: st.clipId, cameraId: st.cameraId, userId: st.userId,
      startedAt: st.startedAt, expiresAt: st.expiresAt, durationMs: st.durationMs,
    }), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
  }

  private restore() {
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (`${saved.clipId}.json` !== name || typeof saved.userId !== 'string' || typeof saved.cameraId !== 'string'
          || !Number.isFinite(saved.startedAt) || !Number.isFinite(saved.expiresAt)) continue;
        this.clips.set(saved.clipId, {
          ...saved, filePath: path.join(this.dir, `${saved.clipId}.mp4`),
          recordPath: path.join(this.dir, `${saved.clipId}.ts`), proc: null,
          stderrTail: '', exited: true, exitCode: null,
        });
      } catch { this.logger.warn(`Catálogo de clipe inválido: ${name}`); }
    }
    this.sweep();
  }
}
