type Zone = { id?: string; kind: string; points: number[][]; sentido?: string };
type Point = [number, number];

function onSegment([x, y]: Point, [ax, ay]: Point, [bx, by]: Point): boolean {
  const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  return Math.abs(cross) < 1e-9 && x >= Math.min(ax, bx) - 1e-9 && x <= Math.max(ax, bx) + 1e-9
    && y >= Math.min(ay, by) - 1e-9 && y <= Math.max(ay, by) + 1e-9;
}

function inside(point: Point, points: number[][]): boolean {
  const [x, y] = point;
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j] as Point, b = points[i] as Point;
    if (onSegment(point, a, b)) return true;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

/** Raw detections still feed overlays/history. Only proven perimeter events make a toast. */
export function noticeWithinPerimeter(type: string, metadata: unknown, zones: unknown): boolean {
  const configured: Zone[] = Array.isArray(zones) ? zones.filter(z => z && ['include', 'exclude', 'line'].includes(z.kind)
    && Array.isArray(z.points) && z.points.length >= (z.kind === 'line' ? 2 : 3)
    && z.points.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))) : [];
  if (!configured.length) return type !== 'LINE_CROSSED';
  const data = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
  const lines = configured.filter(z => z.kind === 'line');
  const areas = configured.filter(z => z.kind !== 'line');
  if (type === 'LINE_CROSSED') {
    return typeof data.linhaId === 'string' && lines.some(line => line.id === data.linhaId && (!line.sentido || line.sentido === 'ambos' || line.sentido === data.sentido));
  }
  // A line is a crossing rule, not a full-image person/movement rule.
  if (lines.length && !areas.some(z => z.kind === 'include')) return false;
  if (!areas.length) return true;
  const width = Number(data.frameWidth), height = Number(data.frameHeight);
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return false;
  const includes = areas.filter(z => z.kind === 'include'), excludes = areas.filter(z => z.kind === 'exclude');
  const boxes = type === 'MOTION_DETECTED' && Array.isArray(data.motionBoxes) ? data.motionBoxes : [data.bbox];
  return boxes.some((box: unknown) => {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(v => typeof v === 'number' && Number.isFinite(v))) return false;
    const [x1, y1, x2, y2] = box as number[];
    if (x2 <= x1 || y2 <= y1 || x1 < 0 || y1 < 0 || x2 > width || y2 > height) return false;
    // Objects use the feet; motion already has a masked component, use its center.
    const point: Point = [(x1 + x2) / (2 * width), (type === 'MOTION_DETECTED' ? (y1 + y2) / 2 : y2) / height];
    return (!includes.length || includes.some(z => inside(point, z.points))) && !excludes.some(z => inside(point, z.points));
  });
}
