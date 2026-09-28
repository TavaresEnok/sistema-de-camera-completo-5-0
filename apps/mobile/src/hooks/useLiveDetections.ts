import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { request } from '../services/api';
import type { LiveDetection, Session } from '../types';

const POLL_INTERVAL_MS = 600;
const HEARTBEAT_INTERVAL_MS = 7000;
const LEASE_TTL_SECONDS = 20;

/**
 * Mantém o overlay de IA do ao vivo: enquanto habilitado para uma câmera, segura um
 * lease (`/ai/live-view`) que faz o backend rodar a inferência on-demand e busca as
 * detecções mais recentes em lote. Ao desabilitar/desmontar, encerra o lease e limpa.
 */
export function useLiveDetections(
  session: Session | null,
  enabled: boolean,
  cameraId: string | null,
): LiveDetection[] {
  const [detections, setDetections] = useState<LiveDetection[]>([]);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!session || !enabled || !foreground || !cameraId) {
      setDetections([]);
      return;
    }
    const sessionId = `mobile-${cameraId}-${Date.now().toString(36)}`;
    let cancelled = false;
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const postLease = (action: 'start' | 'heartbeat' | 'stop') =>
      request(session.apiUrl, `/ai/live-view/${action}/${cameraId}`, session.token, {
        method: 'POST',
        signal: action === 'stop' ? undefined : controller.signal,
        body: JSON.stringify({ sessionId, ttlSeconds: LEASE_TTL_SECONDS, viewMode: 'selected' }),
      }).catch(() => undefined);

    const poll = async () => {
      try {
        const data = await request<{ cameras?: Record<string, { detections?: LiveDetection[] }> }>(
          session.apiUrl,
          `/ai/detections/latest-batch?cameraIds=${encodeURIComponent(cameraId)}&maxAgeMs=900&limit=10`,
          session.token,
          { signal: controller.signal },
        );
        failures = 0;
        if (!cancelled) setDetections(data.cameras?.[cameraId]?.detections ?? []);
      } catch {
        failures++;
        if (!cancelled) setDetections([]);
      } finally {
        if (!cancelled) pollTimer = setTimeout(() => { void poll(); }, Math.min(10_000, POLL_INTERVAL_MS * 2 ** Math.min(failures, 4)));
      }
    };

    void poll();
    const heartbeat = async () => {
      await postLease('heartbeat');
      if (!cancelled) heartbeatTimer = setTimeout(() => { void heartbeat(); }, HEARTBEAT_INTERVAL_MS);
    };
    void postLease('start').then(() => {
      if (!cancelled) heartbeatTimer = setTimeout(() => { void heartbeat(); }, HEARTBEAT_INTERVAL_MS);
    });

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(pollTimer);
      clearTimeout(heartbeatTimer);
      void postLease('stop');
      setDetections([]);
    };
  }, [session?.token, session?.apiUrl, enabled, foreground, cameraId]);

  return detections;
}
