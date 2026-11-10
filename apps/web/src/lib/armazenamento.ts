/** Regras puras da página de Armazenamento (testáveis sem navegador). */

export type Tom = 'ok' | 'aviso' | 'perigo' | 'neutro';
export type Politica = { enabled: boolean; triggerModes: { continuous: boolean; motion: boolean; manual: boolean }; keepLocalCopy: boolean };
export type Visao = {
  days: number;
  cloud: null | { configured: true; provider: string; mode: 'tier' | 'mount'; localWindowHours: number; bucket?: string; endpoint?: string; policy: Politica | null };
  totals: { diskBytes: number; cloudBytes: number; cloudOnlyBytes: number; cloudCount: number; pendingBytes: number; pendingCount: number; recordings: number; lastUploadAt: string | null };
  daily: Array<{ day: string; diskBytes: number; cloudBytes: number }>;
  byCamera: Array<{ cameraId: string; cameraName: string; groupName: string | null; diskBytes: number; cloudBytes: number }>;
  byGroup: Array<{ groupName: string; cameras: number; diskBytes: number; cloudBytes: number }>;
};

/** "3 dias", "3–7 dias" ou null. */
export function rotuloDeRetencao(dias: number[]): string | null {
  const v = [...new Set(dias.filter((d) => Number.isFinite(d) && d > 0))];
  if (!v.length) return null;
  return v.length === 1 ? `${v[0]} dia${v[0] === 1 ? '' : 's'}` : `${Math.min(...v)}–${Math.max(...v)} dias`;
}

export function haQuantoTempo(iso: string | null, agora = Date.now()): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((agora - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `há ${d} dia${d === 1 ? '' : 's'}`;
}

/**
 * A frase do topo: responde "está tudo bem e por quanto tempo guardo?".
 * Ordem = gravidade: disco quase cheio para a gravação; envio parado enche o disco.
 */
export function statusDoArmazenamento(p: {
  discoPercent: number;
  retencao: string | null;
  camerasGravando: number;
  nuvem: Visao['cloud'];
  totais: Pick<Visao['totals'], 'pendingCount' | 'lastUploadAt'>;
  agora?: number;
}): { tom: Tom; texto: string } {
  const agora = p.agora ?? Date.now();
  if (p.discoPercent >= 92) return { tom: 'perigo', texto: `Disco em ${p.discoPercent}% · a gravação é pausada para proteger o sistema` };
  const enviando = Boolean(p.nuvem && p.nuvem.policy?.enabled);
  if (enviando && p.totais.pendingCount > 0) {
    const ultimo = p.totais.lastUploadAt ? new Date(p.totais.lastUploadAt).getTime() : null;
    if (ultimo === null || agora - ultimo > 60 * 60 * 1000) {
      const quando = haQuantoTempo(p.totais.lastUploadAt, agora);
      return { tom: 'aviso', texto: `Envio para a nuvem parado${quando ? ` (último ${quando})` : ''} · ${p.totais.pendingCount} gravações esperando` };
    }
  }
  if (p.discoPercent >= 85) {
    return { tom: 'aviso', texto: enviando ? `Disco em ${p.discoPercent}% · liberando o que já está na nuvem` : `Disco em ${p.discoPercent}% · as gravações mais antigas serão apagadas antes do prazo` };
  }
  if (p.camerasGravando === 0) return { tom: 'neutro', texto: 'Nenhuma câmera está gravando agora' };
  return { tom: 'ok', texto: p.retencao ? `Gravações guardadas por ${p.retencao} · espaço suficiente` : 'Espaço suficiente' };
}

/** Uma linha que resume a nuvem, sem jargão. */
export function resumoDaNuvem(nuvem: Visao['cloud']): string {
  if (!nuvem) return 'Sem nuvem · configurada pela Central';
  const pol = nuvem.policy;
  if (!pol?.enabled) return 'Nuvem instalada · envio desligado';
  const tipos = [pol.triggerModes.motion && 'movimento', pol.triggerModes.continuous && 'contínua', pol.triggerModes.manual && 'manual'].filter(Boolean) as string[];
  if (!tipos.length) return 'Enviando para a nuvem · nenhum tipo escolhido';
  const lista = tipos.length > 1 ? `${tipos.slice(0, -1).join(', ')} e ${tipos[tipos.length - 1]}` : tipos[0];
  const local = pol.keepLocalCopy ? 'cópia local mantida' : `disco liberado após ${nuvem.localWindowHours} h`;
  return `Enviando para a nuvem · ${lista} · ${local}`;
}

/** Pontos do gráfico diário em GB, rótulo dd/mm. */
export function pontosDoGrafico(daily: Visao['daily']) {
  const gb = (b: number) => Math.round((b / 1024 ** 3) * 10) / 10;
  return daily.map((d) => ({ rotulo: `${d.day.slice(8, 10)}/${d.day.slice(5, 7)}`, disco: gb(d.diskBytes), nuvem: gb(d.cloudBytes) }));
}
