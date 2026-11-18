type Zone = { id: string; name: string; kind: string; points: number[][]; sentido?: string; uso?: string; entrada?: string };
type Point = number[];
const side = (a: Point, b: Point, p: Point) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
export function inside(point: Point, polygon: Point[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x, y] = polygon[i], [xx, yy] = polygon[j];
    if (Math.abs((point[0] - xx) * (y - yy) - (point[1] - yy) * (x - xx)) < 1e-9
      && point[0] >= Math.min(x, xx) - 1e-9 && point[0] <= Math.max(x, xx) + 1e-9
      && point[1] >= Math.min(y, yy) - 1e-9 && point[1] <= Math.max(y, yy) + 1e-9) return true;
    if ((y > point[1]) !== (yy > point[1]) && point[0] < (xx - x) * (point[1] - y) / (yy - y) + x) result = !result;
  }
  return result;
}
export function testTrajectory(previous: Point | null, current: Point, zones: Zone[]) {
  const includes = zones.filter((z) => z.kind === 'include');
  const nomes: string[] = [];
  for (const zone of zones) {
    if (zone.kind !== 'line' || !previous || zone.points.length !== 2) continue;
    const [a, b] = zone.points;
    const before = side(a, b, previous), after = side(a, b, current);
    if (Math.abs(before) < 1e-9 && Math.abs(after) < 1e-9) continue;
    if (Math.sign(before) === Math.sign(after)) continue;
    if (Math.sign(side(previous, current, a)) === Math.sign(side(previous, current, b))) continue;
    // Match the detector: areas apply at the crossing, not at either endpoint.
    const fraction = before / (before - after);
    const crossing = previous.map((v, i) => v + fraction * (current[i] - v));
    if (zones.some(z => z.kind === 'exclude' && inside(crossing, z.points))) continue;
    if (includes.length && !includes.some(z => inside(crossing, z.points))) continue;
    const direction = before < 0 ? 'ab' : 'ba';
    // Linha de contagem: qualquer sentido conta — entrada ou saída.
    if (zone.uso === 'contagem') {
      nomes.push(`${zone.name} (${direction === (zone.entrada ?? 'ab') ? 'entrada' : 'saída'})`);
      continue;
    }
    if (!zone.sentido || zone.sentido === 'ambos' || zone.sentido === direction) nomes.push(zone.name);
  }
  return nomes;
}

export function describePerimeterPosition(previous: Point | null, current: Point, zones: Zone[], subject: 'simulação' | 'objeto' | 'movimento') {
  const label = subject === 'simulação' ? 'Movimento simulado' : subject === 'movimento' ? 'Movimento' : 'Objeto';
  const crossing = testTrajectory(previous, current, zones);
  if (crossing.length) return `${subject === 'simulação' ? 'Travessia simulada' : 'Travessia observada'} em ${crossing.join(', ')}`;
  const ignored = zones.find((zone) => zone.kind === 'exclude' && inside(current, zone.points));
  if (ignored) return `${label} ignorado em ${ignored.name}`;
  const included = zones.filter((zone) => zone.kind === 'include');
  if (included.length && !included.some((zone) => inside(current, zone.points))) {
    return `${label} fora da área monitorada`;
  }
  const active = included.find((zone) => inside(current, zone.points));
  if (active) return `${label} dentro de ${active.name}`;
  return subject === 'simulação' ? 'Movimento simulado em área monitorada' : subject === 'movimento' ? 'Movimento observado em área monitorada' : 'Objeto observado em área monitorada';
}
