export interface MotionNotice { id: string; cameraId: string; cameraName: string; occurredAt: string }

/** Keep overlapping polls safe, bounded, and quiet for a busy camera. */
export function selectMotionNotices(items: MotionNotice[], seen: Set<string>, lastByCamera: Map<string, number>, now: number): MotionNotice[] {
  const result: MotionNotice[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const occurred = Date.parse(item.occurredAt);
    if (!Number.isFinite(occurred) || now - occurred > 30_000 || occurred > now + 5000) continue;
    const previous = lastByCamera.get(item.cameraId);
    if (previous !== undefined && now - previous < 30_000) continue;
    lastByCamera.set(item.cameraId, now);
    result.push(item);
  }
  while (seen.size > 1000) seen.delete(seen.values().next().value!);
  for (const [id, last] of lastByCamera) if (now - last > 60_000) lastByCamera.delete(id);
  return result.slice(0, 3);
}
