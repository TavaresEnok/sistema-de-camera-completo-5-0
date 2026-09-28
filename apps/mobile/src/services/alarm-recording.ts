import { request } from './api';
import type { Alarm, Recording, Session } from '../types';

/** Busca somente segmentos que cobrem o instante; nunca substitui por vídeo atual. */
export async function findAlarmRecording(session: Session, alarm: Alarm): Promise<{ recording: Recording; offset: number } | null> {
  if (!alarm.cameraId || !Number.isFinite(Date.parse(alarm.occurredAt))) return null;
  const query = `cameraId=${encodeURIComponent(alarm.cameraId)}&from=${encodeURIComponent(alarm.occurredAt)}&to=${encodeURIComponent(alarm.occurredAt)}&limit=100`;
  const data = await request<{ items: Recording[] }>(session.apiUrl, `/recordings?${query}`, session.token);
  const at = Date.parse(alarm.occurredAt);
  const recording = data.items.find(item => {
    const start = Date.parse(item.startedAt);
    const end = item.endedAt ? Date.parse(item.endedAt) : start + Number(item.durationSeconds ?? 0) * 1000;
    return item.cameraId === alarm.cameraId && start <= at && at <= end && item.fileUsable !== false;
  });
  return recording ? { recording, offset: Math.max(0, (at - Date.parse(recording.startedAt)) / 1000) } : null;
}
