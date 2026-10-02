import type { LiveDetection } from './live-detections-poller';

/** Motion triggers recording but is deliberately not drawn on the Live grid.
 * Preserve state identity when a poll has no visible change, avoiding a render
 * of the entire player for empty results or invisible motion events. */
export function nextLiveOverlayState(
  previous: LiveDetection[], incoming: LiveDetection[],
): LiveDetection[] {
  const visible = incoming.filter(d => d.label !== 'motion' && !d.type.startsWith('MOTION'));
  const same = previous.length === visible.length && visible.every((d, i) => {
    const p = previous[i];
    return p.id === d.id && p.type === d.type && p.label === d.label &&
      p.trackId === d.trackId && p.confidence === d.confidence && p.similarity === d.similarity &&
      p.stationary === d.stationary && p.recovered === d.recovered && p.overlayMode === d.overlayMode &&
      p.frameWidth === d.frameWidth && p.frameHeight === d.frameHeight &&
      p.occurredAt === d.occurredAt && p.bbox.every((v, j) => v === d.bbox[j]);
  });
  return same ? previous : visible;
}
