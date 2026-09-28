import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

/** One raw source per physical URL/transport. Configuration changes create
 * a new generation, leaving existing readers to drain without interruption. */
@Injectable()
export class SharedRtspSourceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SharedRtspSourceService.name);
  private readonly pending = new Map<string, Promise<{ url: string; shared: boolean }>>();
  private readonly known = new Map<string, { url: string; at: number; touched: number }>();
  private cleanupAt = 0;
  private cleanupRunning = false;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly removed = new Set<string>();
  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.cleanupTimer = setInterval(() => { void this.cleanup().catch(() => undefined); }, 300_000);
    this.cleanupTimer.unref();
  }
  onModuleDestroy() { if (this.cleanupTimer) clearInterval(this.cleanupTimer); }

  async resolve(cameraId: string, directUrl: string, transport: string) {
    this.removed.delete(cameraId.replace(/[^a-zA-Z0-9]/g, ''));
    if (String(process.env.CAMERA_SHARED_RTSP_ENABLED ?? 'true') !== 'true'
      || this.config.get<boolean>('mediaMtxEnabled') === false
      || !/^rtsp:\/\//i.test(directUrl)) return { url: directUrl, shared: false };
    const hash = createHash('sha256').update(JSON.stringify([directUrl, transport])).digest('hex').slice(0, 24);
    const name = `cam_${cameraId.replace(/[^a-zA-Z0-9]/g, '')}_raw_${hash}_source`;
    const cached = this.known.get(name);
    if (cached && Date.now() - cached.at < 30_000) {
      cached.touched = Date.now();
      return { url: cached.url, shared: true };
    }
    const pending = this.pending.get(name);
    if (pending) return pending;
    if (this.pending.size >= 64) return { url: directUrl, shared: false };
    const task = this.ensure(name, directUrl, transport).catch(() => {
      this.logger.warn(`Origem compartilhada indisponível para ${cameraId}; usando a origem cadastrada.`);
      return { url: directUrl, shared: false };
    }).finally(() => this.pending.delete(name));
    this.pending.set(name, task);
    return task;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const base = (this.config.get<string>('mediaMtxApiBaseUrl') ?? 'http://mediamtx:9997').replace(/\/+$/, '');
    const user = this.config.get<string>('mediaMtxApiUser') ?? '';
    const pass = this.config.get<string>('mediaMtxApiPass') ?? '';
    const response = await fetch(`${base}${path}`, {
      method, headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw Object.assign(new Error('media_control_failed'), { status: response.status });
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private async ensure(name: string, source: string, transport: string) {
    const path = `/v3/config/paths/get/${encodeURIComponent(name)}`;
    let current: any;
    try { current = await this.request('GET', path); }
    catch (error: any) { if (error.status !== 404) throw error; }
    if (!current) {
      try {
        await this.request('POST', `/v3/config/paths/add/${encodeURIComponent(name)}`, {
          source, rtspTransport: transport, sourceOnDemand: true,
          sourceOnDemandStartTimeout: '10s', sourceOnDemandCloseAfter: '30s',
        });
      } catch (error) {
        current = await this.request('GET', path);
        if (current.source !== source || current.rtspTransport !== transport) throw error;
      }
    } else if (current.source !== source || current.rtspTransport !== transport) {
      throw new Error('shared_source_identity_mismatch');
    }
    const url = new URL(this.config.get<string>('mediaMtxRtspInternalUrl') ?? 'rtsp://mediamtx:8554');
    url.username = encodeURIComponent(this.config.get<string>('mediaMtxApiUser') ?? '');
    url.password = encodeURIComponent(this.config.get<string>('mediaMtxApiPass') ?? '');
    url.pathname = `/${name}`;
    if (this.removed.has(name.split('_')[1])) {
      await this.request('DELETE', `/v3/config/paths/delete/${encodeURIComponent(name)}`);
      throw new Error('camera_source_removed');
    }
    if (this.known.size >= 2048) this.known.delete(this.known.keys().next().value!);
    this.known.set(name, { url: url.toString(), at: Date.now(), touched: Date.now() });
    if (Date.now() - this.cleanupAt > 300_000) {
      this.cleanupAt = Date.now();
      void this.cleanup().catch(() => undefined);
    }
    return { url: url.toString(), shared: true };
  }

  async removeCamera(cameraId: string) {
    const id = cameraId.replace(/[^a-zA-Z0-9]/g, '');
    if (this.removed.size >= 2048) this.removed.delete(this.removed.values().next().value!);
    this.removed.add(id);
    const prefix = `cam_${id}_raw_`;
    const runtime = await this.request('GET', '/v3/paths/list?itemsPerPage=10000');
    for (const item of runtime.items ?? []) {
      if (!String(item.name).startsWith(prefix)) continue;
      await this.request('DELETE', `/v3/config/paths/delete/${encodeURIComponent(item.name)}`);
      this.known.delete(item.name);
    }
  }

  /** A confirmed stalled upstream must be reset without guessing main/sub. */
  async restart(name: string) {
    if (!/^cam_[a-zA-Z0-9]+_raw_[a-f0-9]{24}_source$/.test(name)) throw new Error('invalid_raw_path');
    const config = await this.request('GET', `/v3/config/paths/get/${encodeURIComponent(name)}`);
    this.known.delete(name);
    await this.request('DELETE', `/v3/config/paths/delete/${encodeURIComponent(name)}`);
    await this.ensure(name, config.source, config.rtspTransport);
  }

  private async cleanup() {
    if (this.cleanupRunning || this.config.get<boolean>('mediaMtxEnabled') === false
      || String(process.env.CAMERA_SHARED_RTSP_ENABLED ?? 'true') !== 'true') return;
    this.cleanupRunning = true;
    try {
    const configs = await this.request('GET', '/v3/config/paths/list?itemsPerPage=10000');
    const configured = Array.isArray(configs.items) ? configs.items : [];
    for (const item of configured) {
      if (!/^cam_[a-zA-Z0-9]+_raw_[a-f0-9]{24}_source$/.test(item.name) || this.known.has(item.name)) continue;
      if (this.known.size >= 2048) break;
      this.known.set(item.name, { url: '', at: 0, touched: Date.now() });
    }
    const idle = [...this.known].filter(([, x]) => Date.now() - x.touched > 600_000).slice(0, 16);
    for (const [name, observation] of idle) {
      // An idle raw path can still be the source of an on-demand public path.
      // Do not delete that dependency merely because no viewer is connected.
      if (configured.some((x: any) => x.name !== name && (
        String(x.source ?? '').includes(`/${name}`) || String(x.runOnDemand ?? '').includes(`/${name}`)))) continue;
      const runtime = await this.request('GET', `/v3/paths/get/${encodeURIComponent(name)}`).catch(() => null);
      if (!runtime || !Array.isArray(runtime.readers) || runtime.readers.length) continue;
      if (this.pending.has(name) || this.known.get(name)?.touched !== observation.touched) continue;
      await this.request('DELETE', `/v3/config/paths/delete/${encodeURIComponent(name)}`);
      this.known.delete(name);
    }
    } finally { this.cleanupRunning = false; }
  }
}
