import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rotuloDeRetencao, statusDoArmazenamento, resumoDaNuvem, pontosDoGrafico, haQuantoTempo } from '../src/lib/armazenamento.ts';

const AGORA = Date.parse('2026-11-10T21:00:00Z');
const NUVEM = { configured: true as const, provider: 's3', mode: 'tier' as const, localWindowHours: 24,
  policy: { enabled: true, triggerModes: { continuous: true, motion: true, manual: true }, keepLocalCopy: false } };
const base = { discoPercent: 18, retencao: '7 dias', camerasGravando: 5, nuvem: NUVEM, totais: { pendingCount: 0, lastUploadAt: null }, agora: AGORA };

test('retenção em linguagem simples', () => {
  assert.equal(rotuloDeRetencao([7, 7]), '7 dias');
  assert.equal(rotuloDeRetencao([3, 7, 0]), '3–7 dias');
  assert.equal(rotuloDeRetencao([1]), '1 dia');
  assert.equal(rotuloDeRetencao([]), null);
});

test('status: tudo bem', () => {
  assert.deepEqual(statusDoArmazenamento(base), { tom: 'ok', texto: 'Gravações guardadas por 7 dias · espaço suficiente' });
});

test('status: ninguém gravando é neutro, não alerta', () => {
  assert.equal(statusDoArmazenamento({ ...base, camerasGravando: 0 }).tom, 'neutro');
});

test('status: disco crítico vence tudo', () => {
  const s = statusDoArmazenamento({ ...base, discoPercent: 93 });
  assert.equal(s.tom, 'perigo');
  assert.match(s.texto, /pausada/);
});

test('status: disco cheio com nuvem fala em liberar; sem nuvem fala em apagar antes do prazo', () => {
  assert.match(statusDoArmazenamento({ ...base, discoPercent: 88 }).texto, /liberando/);
  assert.match(statusDoArmazenamento({ ...base, discoPercent: 88, nuvem: null }).texto, /antes do prazo/);
});

test('status: envio parado há mais de 1 h com pendência avisa', () => {
  const s = statusDoArmazenamento({ ...base, totais: { pendingCount: 12, lastUploadAt: '2026-11-10T18:00:00Z' } });
  assert.equal(s.tom, 'aviso');
  assert.match(s.texto, /parado \(último há 3 h\) · 12 gravações/);
  assert.equal(statusDoArmazenamento({ ...base, totais: { pendingCount: 12, lastUploadAt: '2026-11-10T20:50:00Z' } }).tom, 'ok');
});

test('resumo da nuvem', () => {
  assert.equal(resumoDaNuvem(NUVEM), 'Enviando para a nuvem · movimento, contínua e manual · disco liberado após 24 h');
  assert.equal(resumoDaNuvem(null), 'Sem nuvem · configurada pela Central');
  assert.equal(resumoDaNuvem({ ...NUVEM, policy: { ...NUVEM.policy, enabled: false } }), 'Nuvem instalada · envio desligado');
});

test('gráfico em GB com rótulo dd/mm', () => {
  assert.deepEqual(pontosDoGrafico([{ day: '2026-11-10', diskBytes: 1.5 * 1024 ** 3, cloudBytes: 0 }]), [{ rotulo: '10/11', disco: 1.5, nuvem: 0 }]);
});

test('tempo relativo', () => {
  assert.equal(haQuantoTempo('2026-11-10T20:57:00Z', AGORA), 'há 3 min');
  assert.equal(haQuantoTempo(null, AGORA), null);
});

test('página: técnico recolhido e configuração da nuvem atrás de um botão', () => {
  const f = readFileSync('src/pages/StoragePage.tsx', 'utf8');
  assert.match(f, /Detalhes técnicos/);
  assert.match(f, /Configurar/);
  assert.match(f, /statusDoArmazenamento/);
  assert.doesNotMatch(f, /UsagePagination/);
});

test('o endereço do fornecedor da nuvem nunca aparece para o cliente', () => {
  for (const arquivo of ['src/pages/StoragePage.tsx', 'src/components/PreviousStoragesCard.tsx', 'src/components/CloudStorageCard.tsx']) {
    const fonte = readFileSync(arquivo, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(fonte, /\.endpoint\b/, `${arquivo} exibe o endpoint`);
  }
});
