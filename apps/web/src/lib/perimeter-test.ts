type Zone = { id: string; name: string; kind: string; points: number[][]; sentido?: string };
type Point = number[];
const side = (a: Point, b: Point, p: Point) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
export function inside(point: Point, polygon: Point[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x, y] = polygon[i], [xx, yy] = polygon[j];
    if ((y > point[1]) !== (yy > point[1]) && point[0] < (xx - x) * (point[1] - y) / (yy - y) + x) result = !result;
  }
  return result;
}
export function testTrajectory(previous: Point | null, current: Point, zones: Zone[]) {
  if (zones.some((z) => z.kind === 'exclude' && inside(current, z.points))) return [];
  const includes = zones.filter((z) => z.kind === 'include');
  if (includes.length && !includes.some((z) => inside(current, z.points))) return [];
  if (previous && zones.some((z) => z.kind === 'exclude' && inside(previous, z.points))) return [];
  if (previous && includes.length && !includes.some((z) => inside(previous, z.points))) return [];
  return zones.filter((zone) => {
    if (zone.kind !== 'line' || !previous || zone.points.length !== 2) return false;
    const [a, b] = zone.points;
    const before = side(a, b, previous), after = side(a, b, current);
    if (Math.abs(before) < 1e-9 && Math.abs(after) < 1e-9) return false;
    if (Math.sign(before) === Math.sign(after)) return false;
    if (Math.sign(side(previous, current, a)) === Math.sign(side(previous, current, b))) return false;
    const direction = before < 0 ? 'ab' : 'ba';
    return !zone.sentido || zone.sentido === 'ambos' || zone.sentido === direction;
  }).map((z) => z.name);
}

export function describePerimeterPosition(previous: Point | null, current: Point, zones: Zone[], subject: 'simulação' | 'objeto' | 'movimento') {
  const label = subject === 'simulação' ? 'Movimento simulado' : subject === 'movimento' ? 'Movimento' : 'Objeto';
  const ignored = zones.find((zone) => zone.kind === 'exclude' && inside(current, zone.points));
  if (ignored) return `${label} ignorado em ${ignored.name}`;
  const included = zones.filter((zone) => zone.kind === 'include');
  if (included.length && !included.some((zone) => inside(current, zone.points))) {
    return `${label} fora da área monitorada`;
  }
  const crossing = testTrajectory(previous, current, zones);
  if (crossing.length) return `${subject === 'simulação' ? 'Travessia simulada' : 'Travessia observada'} em ${crossing.join(', ')}`;
  const active = included.find((zone) => inside(current, zone.points));
  if (active) return `${label} dentro de ${active.name}`;
  return subject === 'simulação' ? 'Movimento simulado em área monitorada' : subject === 'movimento' ? 'Movimento observado em área monitorada' : 'Objeto observado em área monitorada';
}
