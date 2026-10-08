const LABEL_CLASSES: Record<string, string> = {
  person: 'person', pessoa: 'person', pessoas: 'person',
  car: 'car', carro: 'car', motorcycle: 'motorcycle', moto: 'motorcycle', motocicleta: 'motorcycle',
  bicycle: 'bicycle', bicicleta: 'bicycle', bus: 'bus', 'ônibus': 'bus', onibus: 'bus',
  truck: 'truck', 'caminhão': 'truck', caminhao: 'truck',
};

export function noticeObjectClass(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const data = metadata as Record<string, unknown>;
  const label = typeof data.label === 'string' ? data.label.trim().toLowerCase() : '';
  return LABEL_CLASSES[label] ?? null;
}

/** Empty selection means all licensed classes, never an unlicensed fallback. */
export function noticeClasses(allowed: string[], selected: unknown): string[] {
  if (!Array.isArray(selected) || !selected.length) return [...allowed];
  return [...new Set(selected.filter((c): c is string => typeof c === 'string' && allowed.includes(c)))];
}
