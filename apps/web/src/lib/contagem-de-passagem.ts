/** Regras puras da tela de contagem de passagem (testáveis sem navegador). */

export type Periodo = 'hoje' | '7d' | '30d';
export type LinhaDaSerie = { bucket: string; cameraId: string; lineId: string; lineName: string; in: number; out: number };
export type PontoDoGrafico = { bucket: string; rotulo: string; in: number; out: number };
export const FUSO_DA_CONTAGEM = 'America/Sao_Paulo';

function dataNoFuso(d: Date): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DA_CONTAGEM, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return [part('year'), part('month'), part('day')];
}

function inicioDoDia(year: number, month: number, day: number): Date {
  const midnight = Date.UTC(year, month - 1, day);
  let instant = midnight;
  // Resolve local midnight using IANA rules, independently of the browser's timezone.
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DA_CONTAGEM, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
    const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
    const localAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    instant += midnight - localAsUtc;
  }
  return new Date(instant);
}

/** Hoje = desde a meia-noite, por hora. 7/30 dias = dias inteiros, por dia. */
export function periodoDaContagem(periodo: Periodo, agora: Date): { from: Date; to: Date; groupBy: 'hour' | 'day' } {
  const [year, month, day] = dataNoFuso(agora);
  const hoje = inicioDoDia(year, month, day);
  if (periodo === 'hoje') return { from: hoje, to: agora, groupBy: 'hour' };
  const dias = periodo === '7d' ? 7 : 30;
  const previous = new Date(Date.UTC(year, month - 1, day - (dias - 1)));
  const from = inicioDoDia(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate());
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
  let texto = String(valor);
  // Names are operator-controlled; Excel must not interpret them as formulas.
  if (typeof valor === 'string' && /^[\s]*[=+@-]|^[\t\r]/.test(texto)) texto = "'" + texto;
  return /[";\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
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
