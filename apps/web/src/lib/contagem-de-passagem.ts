/** Regras puras da tela de contagem de passagem (testáveis sem navegador). */

export type Periodo = 'hoje' | '7d' | '30d';
export type LinhaDaSerie = { bucket: string; cameraId: string; lineId: string; lineName: string; in: number; out: number };
export type PontoDoGrafico = { bucket: string; rotulo: string; in: number; out: number };

function inicioDoDia(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Hoje = desde a meia-noite, por hora. 7/30 dias = dias inteiros, por dia. */
export function periodoDaContagem(periodo: Periodo, agora: Date): { from: Date; to: Date; groupBy: 'hour' | 'day' } {
  const hoje = inicioDoDia(agora);
  if (periodo === 'hoje') return { from: hoje, to: agora, groupBy: 'hour' };
  const dias = periodo === '7d' ? 7 : 30;
  const from = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - (dias - 1));
  return { from, to: agora, groupBy: 'day' };
}

/** "2026-11-10T14:00" → "14h" (hora) ou "10/11" (dia). */
export function rotuloDoBalde(bucket: string, groupBy: 'hour' | 'day'): string {
  const [data, hora = '00:00'] = bucket.split('T');
  if (groupBy === 'hour') return `${hora.slice(0, 2)}h`;
  const [, mes, dia] = data.split('-');
  return `${dia}/${mes}`;
}

/** Soma todas as linhas em cada balde, em ordem cronológica. */
export function somarPorBalde(series: LinhaDaSerie[], groupBy: 'hour' | 'day'): PontoDoGrafico[] {
  const mapa = new Map<string, PontoDoGrafico>();
  for (const s of series) {
    const atual = mapa.get(s.bucket) ?? { bucket: s.bucket, rotulo: rotuloDoBalde(s.bucket, groupBy), in: 0, out: 0 };
    atual.in += s.in;
    atual.out += s.out;
    mapa.set(s.bucket, atual);
  }
  return [...mapa.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

function celula(valor: string | number): string {
  const texto = String(valor);
  return /[";\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/** CSV com ";" (abre direto no Excel em português). */
export function csvDaContagem(
  series: LinhaDaSerie[],
  linhas: Array<{ cameraId: string; cameraName: string; lineId: string }>,
  comSaidas: boolean,
): string {
  const nomeDaCamera = new Map(linhas.map((l) => [`${l.cameraId}|${l.lineId}`, l.cameraName]));
  const cabecalho = ['Período', 'Câmera', 'Linha', 'Entradas', ...(comSaidas ? ['Saídas'] : [])];
  const linhasCsv = series.map((s) => [
    s.bucket.replace('T', ' '),
    nomeDaCamera.get(`${s.cameraId}|${s.lineId}`) ?? s.cameraId,
    s.lineName,
    s.in,
    ...(comSaidas ? [s.out] : []),
  ].map(celula).join(';'));
  return '﻿' + [cabecalho.join(';'), ...linhasCsv].join('\n') + '\n';
}
