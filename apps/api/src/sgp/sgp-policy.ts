import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const STATES = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export type SgpState = typeof STATES[number];
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException({ error: 'Informe um objeto JSON válido.' });
  return value as Record<string, any>;
}
export function text(value: unknown, name: string, max = 150): string {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw new BadRequestException({ error: `Campo ${name} inválido.` });
  const result = String(value).trim();
  if (!result || result.length > max || /[\x00-\x1f\x7f]/.test(result)) throw new BadRequestException({ error: `Campo ${name} inválido.` });
  return result;
}
export function cpf(value: unknown): string {
  const result = text(value, 'cliente.cpfcnpj', 18).replace(/[.\-\s]/g, '');
  if (!/^\d{11}$/.test(result) || /^(\d)\1{10}$/.test(result)) throw new BadRequestException({ error: 'Informe um CPF válido. Cadastros com CNPJ precisam de um usuário responsável com CPF.' });
  for (let size = 9; size <= 10; size++) {
    const sum = [...result.slice(0, size)].reduce((total, digit, index) => total + Number(digit) * (size + 1 - index), 0);
    if ((sum * 10 % 11 % 10) !== Number(result[size])) throw new BadRequestException({ error: 'CPF inválido.' });
  }
  return result;
}
export function sourceTime(value: unknown, offset: number): Date {
  const input = text(value, 'data', 50);
  let date: Date;
  const local = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(input);
  if (local) {
    const [, day, month, year, hour, minute, second, fraction] = local;
    const utc = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second, Number((fraction ?? '').padEnd(3, '0').slice(0, 3)));
    const check = new Date(utc);
    if (check.getUTCFullYear() !== +year || check.getUTCMonth() !== +month - 1 || check.getUTCDate() !== +day || +hour > 23 || +minute > 59 || +second > 59) throw new BadRequestException({ error: 'Data do evento inválida.' });
    date = new Date(utc - offset * 60_000);
  } else {
    const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(input);
    if (!iso) throw new BadRequestException({ error: 'Use data do SGP ou ISO 8601 com fuso horário.' });
    const calendar = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    if (calendar.getUTCFullYear() !== +iso[1] || calendar.getUTCMonth() !== +iso[2] - 1 || calendar.getUTCDate() !== +iso[3] || +iso[4] > 23 || +iso[5] > 59 || +iso[6] > 59) throw new BadRequestException({ error: 'Data do evento inválida.' });
    date = new Date(input);
  }
  if (!Number.isFinite(date.getTime()) || date.getTime() < 0 || date.getTime() > Date.now() + 300_000) throw new BadRequestException({ error: 'Data inválida ou adiantada. Confira o fuso horário da integração.' });
  return date;
}
export function statusMap(value: unknown): Record<string, SgpState> {
  const input = object(value);
  const pairs = Object.entries(input);
  if (!pairs.length || pairs.length > 30) throw new BadRequestException({ error: 'Configure entre 1 e 30 situações do SGP.' });
  const output: Record<string, SgpState> = Object.create(null);
  for (const [key, state] of pairs) {
    if (!STATES.includes(state as SgpState)) throw new BadRequestException({ error: 'Situação de destino inválida.' });
    const normalized = text(key, 'situação', 80).toUpperCase();
    if (output[normalized]) throw new BadRequestException({ error: 'Situação repetida no mapeamento.' });
    output[normalized] = state as SgpState;
  }
  return output;
}
export function customerState(states: string[], archived: boolean): SgpState {
  if (archived) return 'ARCHIVED';
  if (states.includes('ACTIVE')) return 'ACTIVE';
  return states.length && states.every(state => state === 'ARCHIVED') ? 'ARCHIVED' : 'SUSPENDED';
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function parseEvent(body: unknown, config: { statusMap: unknown; utcOffsetMinutes: number; planIds: string[] }) {
  const input = object(body), client = object(input.cliente), service = object(input.servico), contract = object(input.contrato);
  const action = text(input.acao, 'acao', 30);
  if (!['cadastrar', 'atualizar', 'alterar_plano', 'alterar_status'].includes(action)) throw new BadRequestException({ error: 'Ação do SGP não reconhecida.' });
  const planId = text(object(service.plano).id, 'servico.plano.id');
  if (config.planIds.length && !config.planIds.includes(planId)) throw new BadRequestException({ error: 'Este plano não está autorizado nesta integração.' });
  const state = statusMap(config.statusMap)[text(service.status, 'servico.status', 80).toUpperCase()];
  if (!state) throw new BadRequestException({ error: 'Situação do SGP não mapeada. Configure-a na página Integrações.' });
  const event = {
    action, customerId: text(client.id, 'cliente.id'), serviceId: text(service.id, 'servico.id'),
    contractId: text(contract.id, 'contrato.id'), name: text(client.nome, 'cliente.nome'),
    username: cpf(client.cpfcnpj), state, planId, sourceAt: sourceTime(input.data, config.utcOffsetMinutes),
  };
  // PostgreSQL timestamps use milliseconds here; retain the SGP microseconds for ordering.
  const fraction = /\.(\d{1,6})/.exec(String(input.data))?.[1] ?? '';
  const sourceOrder = String(event.sourceAt.getTime()).padStart(16, '0') + fraction.padEnd(6, '0').slice(3, 6);
  return { ...event, sourceOrder, payloadHash: hash(JSON.stringify({ ...event, sourceOrder })), eventId: input.event_id == null ? null : text(input.event_id, 'event_id') };
}
