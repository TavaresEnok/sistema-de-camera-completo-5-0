/**
 * Poller compartilhado de detecções de IA para a página Live.
 *
 * Em vez de cada tile fazer seu próprio polling (N câmeras × 2 req/s, que estoura o
 * rate-limit numa grade cheia), todos os tiles assinam aqui e um único timer busca as
 * detecções de todas as câmeras assinadas em uma requisição em lote por ciclo.
 */
import axios from 'axios';
import { getApiBaseUrl } from './api-base';
import { useAuthStore } from '../store/authStore';

export type LiveDetection = {
  id: string;
  type: string;
  label: string;
  confidence: number | null;
  similarity: number | null;
  bbox: [number, number, number, number];
  frameWidth: number | null;
  frameHeight: number | null;
  occurredAt: string;
  detectedAtMs?: number;
  recent?: boolean;
  ageMs?: number;
  expiresAtMs?: number;
  overlayMode?: string | null;
  trackId?: number | null;
  stationary?: boolean | null;
  recovered?: boolean | null;
};

type Subscriber = (detections: LiveDetection[], recent?: LiveDetection[]) => void;

const POLL_INTERVAL_MS = 500;
const MAX_AGE_MS = 700;
const PER_CAMERA_LIMIT = 10;

class LiveDetectionsPoller {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private request: AbortController | null = null;
  private generation = 0;
  // Falha de rede/auth NÃO deve apagar a grade inteira num piscar: seguramos o
  // último payload bom por até MAX_FAILURE_HOLDS ciclos (e nunca além do TTL),
  // depois limpamos para não exibir caixa obsoleta.
  private consecutiveFailures = 0;
  private readonly lastGood = new Map<string, { detections: LiveDetection[]; at: number }>();
  private static readonly MAX_FAILURE_HOLDS = 2;
  private static readonly FAILURE_HOLD_TTL_MS = 1600;

  subscribe(cameraId: string, callback: Subscriber): () => void {
    let set = this.subscribers.get(cameraId);
    if (!set) {
      set = new Set();
      this.subscribers.set(cameraId, set);
    }
    set.add(callback);
    this.ensureTimer();

    return () => {
      const current = this.subscribers.get(cameraId);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) {
        this.subscribers.delete(cameraId);
        this.lastGood.delete(cameraId);
      }
      if (this.subscribers.size === 0) this.stopTimer();
    };
  }

  private ensureTimer() {
    if (this.timer != null) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private stopTimer() {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    this.generation += 1;
    this.request?.abort();
    this.request = null;
    this.inFlight = false;
    this.lastGood.clear();
    this.consecutiveFailures = 0;
  }

  private emit(cameraId: string, detections: LiveDetection[], recent: LiveDetection[] = []) {
    const set = this.subscribers.get(cameraId);
    if (!set) return;
    for (const callback of set) {
      try { callback(detections, recent); } catch { /* Uma tela não interrompe as demais. */ }
    }
  }

  private async poll() {
    if (this.inFlight) return;
    const cameraIds = [...this.subscribers.keys()];
    if (!cameraIds.length) return;

    const accessToken = useAuthStore.getState().accessToken;
    if (!accessToken) return;

    this.inFlight = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.request = controller;
    const userId = useAuthStore.getState().user?.id;
    const startedAt = performance.now();
    try {
      const response = await axios.get<{ cameras?: Record<string, { detections?: LiveDetection[]; recentDetections?: LiveDetection[] }> }>(
        `${getApiBaseUrl()}/ai/detections/latest-batch`,
        {
          params: { cameraIds: cameraIds.join(','), maxAgeMs: MAX_AGE_MS, limit: PER_CAMERA_LIMIT },
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 4000,
          signal: controller.signal,
        },
      );
      if (generation !== this.generation || useAuthStore.getState().user?.id !== userId) return;
      const cameras = response.data?.cameras ?? {};
      this.consecutiveFailures = 0;
      const now = Date.now();
      for (const cameraId of cameraIds) {
        if (!this.subscribers.has(cameraId)) continue;
        const detections = Array.isArray(cameras[cameraId]?.detections) ? cameras[cameraId]!.detections! : [];
        if (detections.length > 0) {
          this.lastGood.set(cameraId, { detections, at: now });
        } else {
          this.lastGood.delete(cameraId);
        }
        const transportMs = performance.now() - startedAt;
        const recentItems = cameras[cameraId]?.recentDetections;
        const recent = (Array.isArray(recentItems) ? recentItems : [])
          .filter(item => item.recent === true && Number.isFinite(item.ageMs) && item.ageMs! >= 0 && item.ageMs! + transportMs < 1200)
          .map(item => ({ ...item, expiresAtMs: now + 1200 - item.ageMs! - transportMs }));
        this.emit(cameraId, detections, recent);
      }
    } catch {
      if (generation !== this.generation || useAuthStore.getState().user?.id !== userId) return;
      this.consecutiveFailures += 1;
      const now = Date.now();
      const withinHold = this.consecutiveFailures <= LiveDetectionsPoller.MAX_FAILURE_HOLDS;
      for (const cameraId of cameraIds) {
        if (!this.subscribers.has(cameraId)) continue;
        const held = this.lastGood.get(cameraId);
        const fresh = held != null && now - held.at <= LiveDetectionsPoller.FAILURE_HOLD_TTL_MS;
        if (withinHold && fresh) {
          this.emit(cameraId, held.detections);
        } else {
          this.lastGood.delete(cameraId);
          this.emit(cameraId, []);
        }
      }
    } finally {
      if (generation === this.generation) {
        this.inFlight = false;
        this.request = null;
      }
    }
  }
}

export const liveDetectionsPoller = new LiveDetectionsPoller();
