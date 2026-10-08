export function liveCapacityWait(status: number | undefined, body: unknown, random = Math.random()) {
  if (status !== 503 || !body || typeof body !== 'object' || !('error' in body)
    || body.error !== 'live_capacity_reached') return null;
  return {
    message: 'Estamos aguardando recursos para abrir esta câmera. Tentaremos novamente em instantes.',
    // Spread retries from many tiles/tabs; no protocol fallback during this wait.
    delayMs: 30_000 + Math.floor(Math.max(0, Math.min(1, random)) * 10_000),
  };
}
