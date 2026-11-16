/**
 * Regras puras da contagem de passagem — testáveis sem banco.
 *
 * A linha de contagem mora em `Camera.detectionZones` (kind 'line', uso
 * 'contagem'). A IA envia totais por minuto; aqui validamos o lote e as
 * consultas antes de qualquer SQL.
 */

export const QUADROS_DE_CONTAGEM = [5, 8, 12] as const;
export const RETENCAO_DIAS = 400;
export const MAX_BALDES_POR_LOTE = 500;
export const MAX_DIAS_POR_HORA = 31;

export type LinhaDeContagem = { id: string; name: string; entrada: 'ab' | 'ba'; classes: string[] };

export type BaldeDeContagem = {
  minuteStart: Date;
  lineId: string;
  lineName: string;
  classLabel: string;
  direction: 'in' | 'out';
  count: number;
};

export function ehLinhaDeContagem(z: any): boolean {
  return Boolean(z && z.kind === 'line' && z.uso === 'contagem');
}

export function linhasDeContagem(zonas: unknown): LinhaDeContagem[] {
  if (!Array.isArray(zonas)) return [];
  return zonas.filter(ehLinhaDeContagem).map((z: any): LinhaDeContagem => ({
    id: String(z.id ?? ''),
    name: String(z.name ?? 'Linha'),
    entrada: z.entrada === 'ba' ? 'ba' : 'ab',
    classes: Array.isArray(z.classes) && z.classes.length ? z.classes.map((c: unknown) => String(c)) : ['person'],
  })).filter((l) => l.id);
}

/** Taxa válida para a câmera, ou null (= padrão). Lança se vier lixo. */
export function normalizarQuadrosDeContagem(valor: unknown): number | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!(QUADROS_DE_CONTAGEM as readonly number[]).includes(n)) {
    throw new Error('A taxa de contagem deve ser 5, 8 ou 12 quadros por segundo.');
  }
  return n;
}

/**
 * Valida o lote enviado pela IA. Só aceita minutos de linhas de contagem que
 * EXISTEM na câmera — um id inventado não vira linha fantasma no relatório.
 */
export function validarLote(body: any, linhas: LinhaDeContagem[], agora = new Date()): { session: string; baldes: BaldeDeContagem[] } {
  const session = typeof body?.session === 'string' ? body.session.trim() : '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(session)) throw new Error('Sessão inválida.');
  const brutos = Array.isArray(body?.buckets) ? body.buckets : null;
  if (!brutos) throw new Error('Lote sem baldes.');
  if (brutos.length > MAX_BALDES_POR_LOTE) throw new Error('Lote grande demais.');
  const porId = new Map(linhas.map((l) => [l.id, l]));
  const limiteFuturo = agora.getTime() + 5 * 60_000;
  const limitePassado = agora.getTime() - RETENCAO_DIAS * 86_400_000;
  const baldes = new Map<string, BaldeDeContagem>();
  for (const b of brutos) {
    const linha = porId.get(String(b?.lineId ?? ''));
    if (!linha) continue; // linha removida/alterada desde o envio: descarta em silêncio
    const minuto = new Date(String(b?.minuteStart ?? ''));
    const t = minuto.getTime();
    if (!Number.isFinite(t) || t % 60_000 !== 0 || t > limiteFuturo || t < limitePassado) {
      throw new Error('Minuto inválido no lote.');
    }
    const direction = b?.direction;
    if (direction !== 'in' && direction !== 'out') throw new Error('Direção inválida no lote.');
    const count = Number(b?.count);
    if (!Number.isInteger(count) || count < 0 || count > 100_000) throw new Error('Contagem inválida no lote.');
    const classLabel = String(b?.classLabel ?? '').trim().toLowerCase().slice(0, 40);
    if (!classLabel) throw new Error('Classe inválida no lote.');
    if (!linha.classes.includes(classLabel)) continue;
    const key = JSON.stringify([t, linha.id, classLabel, direction]);
    // A duplicate key in one INSERT would make PostgreSQL reject the whole batch.
    const previous = baldes.get(key);
    if (!previous || count > previous.count) baldes.set(key, { minuteStart: minuto, lineId: linha.id, lineName: linha.name.slice(0, 120), classLabel, direction, count });
  }
  return { session, baldes: [...baldes.values()] };
}

export type TipoDeContagem = 'all' | 'person' | 'vehicle';
export function validarTipoDeContagem(value?: string): TipoDeContagem {
  if (value === undefined || value === 'all') return 'all';
  if (value === 'person' || value === 'vehicle') return value;
  throw new Error('Tipo de contagem inválido.');
}

export type ConsultaDeContagem = { from: Date; to: Date; groupBy: 'hour' | 'day' };

/** Período padrão: hoje (fuso de Brasília) agrupado por hora. */
export function validarConsulta(q: { from?: string; to?: string; groupBy?: string }, agora = new Date()): ConsultaDeContagem {
  const groupBy = q.groupBy === 'day' ? 'day' : 'hour';
  const to = q.to ? new Date(q.to) : agora;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 86_400_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error('Período inválido.');
  }
  const dias = (to.getTime() - from.getTime()) / 86_400_000;
  if (dias > RETENCAO_DIAS + 1) throw new Error(`Período máximo: ${RETENCAO_DIAS} dias.`);
  if (groupBy === 'hour' && dias > MAX_DIAS_POR_HORA) throw new Error(`Por hora, o período máximo é ${MAX_DIAS_POR_HORA} dias.`);
  return { from, to, groupBy };
}
