/** Regras puras do painel de uso da nuvem. */
export type UsoDaNuvem =
  | { enabled: false }
  | {
    enabled: true;
    days: number;
    totals: { cloudBytes: number; cloudCount: number; pendingBytes: number; pendingCount: number; cloudOnlyBytes: number; localBytes: number; lastUploadAt: string | null };
    daily: Array<{ day: string; uploadedBytes: number; uploadedCount: number }>;
    byCamera: Array<{ cameraId: string; cameraName: string; cloudBytes: number; localBytes: number; pendingBytes: number }>;
  };

/** "há 3 min", "há 2 h", "há 4 dias", ou null quando nunca enviou. */
export function haQuantoTempo(iso: string | null, agora = Date.now()): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((agora - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dia${Math.round(s / 86400) === 1 ? '' : 's'}`;
}

/** Pontos do gráfico em GB, com rótulo curto "10/11". */
export function pontosDoEnvio(daily: Array<{ day: string; uploadedBytes: number; uploadedCount: number }>) {
  return daily.map((d) => ({
    rotulo: `${d.day.slice(8, 10)}/${d.day.slice(5, 7)}`,
    gb: Math.round((d.uploadedBytes / 1024 ** 3) * 100) / 100,
    gravacoes: d.uploadedCount,
  }));
}

/** Atraso preocupa quando há envio pendente e o último envio foi há mais de 1 h. */
export function envioAtrasado(totals: { pendingCount: number; lastUploadAt: string | null }, agora = Date.now()): boolean {
  if (totals.pendingCount === 0) return false;
  if (!totals.lastUploadAt) return totals.pendingCount > 0;
  return agora - new Date(totals.lastUploadAt).getTime() > 60 * 60 * 1000;
}
