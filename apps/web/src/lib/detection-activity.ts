export const DETECTION_HIGHLIGHT_MS = 5000;

export function hasFreshDetection(items: { type: string; occurredAt: string; expiresAtMs?: number }[], now = Date.now()): boolean {
  return items.some(item => {
    if (!['MOTION_DETECTED', 'OBJECT_DETECTED'].includes(item.type)) return false;
    const occurred = Date.parse(item.occurredAt);
    return Number.isFinite(occurred) && occurred <= now + 1000 && now - occurred <= DETECTION_HIGHLIGHT_MS
      && (item.expiresAtMs === undefined || item.expiresAtMs > now);
  });
}

/** UI-only activity: no analysis, recording, persistent state or camera changes. */
export class DetectionActivityTimeline {
  private expires = new Map<string, number>();
  mark(cameraId: string, now = Date.now()): boolean {
    const first = !this.expires.has(cameraId);
    this.expires.set(cameraId, now + DETECTION_HIGHLIGHT_MS);
    return first;
  }
  expire(now = Date.now()): string[] {
    const expired: string[] = [];
    for (const [id, end] of this.expires) if (end <= now) { this.expires.delete(id); expired.push(id); }
    return expired;
  }
  get size(): number { return this.expires.size; }
  clear() { this.expires.clear(); }
}
