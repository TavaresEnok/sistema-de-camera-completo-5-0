export type PerimeterProcessor = {
  configuration_revision?: string;
  running?: boolean;
  last_seen?: number;
  readiness?: { ready?: boolean; frame_age_seconds?: number | null };
  inference?: { status?: string };
  motion_detector?: { perimeter_ignored_motion?: { zone: string; at: number } | null };
};

export function perimeterState(online: boolean, hasLines: boolean, processor: PerimeterProcessor | undefined, checked: boolean, now = Date.now()) {
  if (!online) return { label: 'Câmera desconectada', attention: true, tone: 'warning' as const };
  if (!checked) return { label: 'Verificando detecção', attention: false, tone: 'checking' as const };
  if (!processor) return { label: 'Detecção ainda não iniciou', attention: true, tone: 'warning' as const };
  const recent = typeof processor.last_seen === 'number' && now / 1000 - processor.last_seen <= 20;
  if (!processor.running || !recent || processor.readiness?.ready === false) return { label: 'Detecção parada', attention: true, tone: 'warning' as const };
  if (hasLines && processor.inference?.status !== 'ok') return { label: 'Travessia ainda não está funcionando', attention: true, tone: 'warning' as const };
  return { label: 'Detecção ligada', attention: false, tone: 'ok' as const };
}

// ab = lado negativo → positivo, igual ao avaliador de travessia da API.
export function crossingArrow(points: number[][]) {
  if (points.length !== 2) return null;
  const [[ax, ay], [bx, by]] = points;
  const length = Math.hypot(bx - ax, by - ay);
  if (length < 0.000001) return null;
  const x = (ax + bx) * 50, y = (ay + by) * 50;
  const nx = -(by - ay) / length * 6, ny = (bx - ax) / length * 6;
  return { x1: x - nx, y1: y - ny, x2: x + nx, y2: y + ny };
}
