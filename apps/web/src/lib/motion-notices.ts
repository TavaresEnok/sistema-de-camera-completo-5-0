export interface MotionNotice { id: string; cameraId: string; cameraName: string; occurredAt: string; detectionType?: 'motion' | 'object'; objectClass?: string | null }

export function detectionNoticeMessage(notice: MotionNotice): string {
  const labels: Record<string, string> = { person: 'uma pessoa', car: 'um carro', motorcycle: 'uma moto', bicycle: 'uma bicicleta', bus: 'um ônibus', truck: 'um caminhão' };
  const detection = notice.detectionType === 'object' ? (labels[notice.objectClass ?? ''] ?? 'um objeto') : 'movimento';
  return `${notice.cameraName} detectou ${detection}.`;
}

/** Keep overlapping polls safe, bounded, and quiet for a busy camera. */
export function selectMotionNotices(items: MotionNotice[], seen: Set<string>, lastByCamera: Map<string, number>, now: number): MotionNotice[] {
  const result: MotionNotice[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const occurred = Date.parse(item.occurredAt);
    if (!Number.isFinite(occurred) || now - occurred > 30_000 || occurred > now + 5000) continue;
    // A movement notice must not hide a person arriving immediately afterwards.
    const key = `${item.cameraId}:${item.detectionType ?? 'motion'}:${item.objectClass ?? ''}`;
    const previous = lastByCamera.get(key);
    if (previous !== undefined && now - previous < 30_000) continue;
    lastByCamera.set(key, now);
    result.push(item);
  }
  while (seen.size > 1000) seen.delete(seen.values().next().value!);
  for (const [id, last] of lastByCamera) if (now - last > 60_000) lastByCamera.delete(id);
  return result.slice(0, 3);
}
