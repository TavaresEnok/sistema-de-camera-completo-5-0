export function safeWhepSessionUrl(location: string | null, endpoint: string): string | null {
  if (!location) return null;
  const base = new URL(endpoint);
  const resolved = new URL(location, base);
  if (resolved.origin !== base.origin || resolved.username || resolved.password
    || !['http:', 'https:'].includes(resolved.protocol)) {
    throw new Error('Endereço de sessão de vídeo inválido.');
  }
  return resolved.toString();
}

export function presentedFrameRate(previous: number, current: number, elapsedMs: number): number | null {
  if (![previous, current, elapsedMs].every(Number.isFinite)
    || elapsedMs <= 0 || current < previous) return null;
  return Math.max(0, Math.round((current - previous) * 1000 / elapsedMs));
}
