import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linhasDeContagem,
  normalizarQuadrosDeContagem,
  validarConsulta,
  validarLote,
} from '../src/passage-counts/passage-count.helper';
import { decidirObjetoDaCamera, temLinhaDeContagem, temLinhaDePerimetro } from '../src/ai/helpers/escopo-de-objeto.helper';
import { noticeWithinPerimeter } from '../src/cameras/helpers/notice-perimeter.helper';
import { validarZonasDeDeteccao } from '../src/cameras/helpers/validar-zonas.helper';

const LINHA = { id: 'porta', name: 'Porta', kind: 'line', points: [[0.5, 0.2], [0.5, 0.8]], uso: 'contagem', entrada: 'ab' };
const LINHA_ALERTA = { id: 'muro', name: 'Muro', kind: 'line', points: [[0.1, 0.1], [0.9, 0.1]], sentido: 'ambos' };
const AGORA = new Date('2026-11-10T15:00:30Z');
const SESSAO = 'a1b2c3d4e5f6a7b8';

test('linhasDeContagem: só linhas com uso contagem, classe padrão pessoa', () => {
  const linhas = linhasDeContagem([LINHA, LINHA_ALERTA, { id: 'z', kind: 'include', points: [] }]);
  assert.deepEqual(linhas, [{ id: 'porta', name: 'Porta', entrada: 'ab', classes: ['person'] }]);
});

test('quadros: só 5, 8 ou 12; vazio volta ao padrão', () => {
  assert.equal(normalizarQuadrosDeContagem(8), 8);
  assert.equal(normalizarQuadrosDeContagem(null), null);
  assert.throws(() => normalizarQuadrosDeContagem(30));
});

test('lote válido vira baldes por minuto', () => {
  const { session, baldes } = validarLote({
    session: SESSAO,
    buckets: [{ minuteStart: '2026-11-10T15:00:00Z', lineId: 'porta', lineName: 'Porta', classLabel: 'person', direction: 'in', count: 7 }],
  }, linhasDeContagem([LINHA]), AGORA);
  assert.equal(session, SESSAO);
  assert.equal(baldes.length, 1);
  assert.equal(baldes[0].count, 7);
  assert.equal(baldes[0].direction, 'in');
});

test('lote: linha que não existe na câmera é descartada, não vira linha fantasma', () => {
  const { baldes } = validarLote({
    session: SESSAO,
    buckets: [{ minuteStart: '2026-11-10T15:00:00Z', lineId: 'inventada', classLabel: 'person', direction: 'in', count: 1 }],
  }, linhasDeContagem([LINHA]), AGORA);
  assert.equal(baldes.length, 0);
});

test('lote: recusa minuto quebrado, futuro, direção e contagem inválidas', () => {
  const linhas = linhasDeContagem([LINHA]);
  const base = { minuteStart: '2026-11-10T15:00:00Z', lineId: 'porta', classLabel: 'person', direction: 'in', count: 1 };
  for (const ruim of [
    { minuteStart: '2026-11-10T15:00:10Z' },
    { minuteStart: '2026-11-10T18:00:00Z' },
    { direction: 'lado' },
    { count: -1 },
    { count: 1.5 },
  ]) {
    assert.throws(() => validarLote({ session: SESSAO, buckets: [{ ...base, ...ruim }] }, linhas, AGORA));
  }
  assert.throws(() => validarLote({ session: 'x', buckets: [base] }, linhas, AGORA));
});

test('consulta: padrão é últimas 24 h por hora; limita períodos', () => {
  const c = validarConsulta({}, AGORA);
  assert.equal(c.groupBy, 'hour');
  assert.equal(c.to.getTime() - c.from.getTime(), 86_400_000);
  assert.throws(() => validarConsulta({ from: '2026-01-01', to: '2026-03-01', groupBy: 'hour' }, AGORA));
  assert.doesNotThrow(() => validarConsulta({ from: '2026-01-01', to: '2026-03-01', groupBy: 'day' }, AGORA));
  assert.throws(() => validarConsulta({ from: '2026-11-10', to: '2026-11-09' }, AGORA));
});

test('escopo: linha de contagem liga objeto só para contar; não é perímetro', () => {
  assert.equal(temLinhaDeContagem([LINHA]), true);
  assert.equal(temLinhaDePerimetro([LINHA]), false);
  const d = decidirObjetoDaCamera({ id: 'c', detectionZones: [LINHA] } as any, { politicaLiberaObjeto: true });
  assert.deepEqual([d.roda, d.motivo], [true, 'linha-de-contagem']);
});

test('escopo: com linha de alerta junto, vale o perímetro (eventos continuam)', () => {
  const d = decidirObjetoDaCamera({ id: 'c', detectionZones: [LINHA, LINHA_ALERTA] } as any, { politicaLiberaObjeto: true });
  assert.equal(d.motivo, 'linha-de-perimetro');
});

test('escopo: contagem respeita a política da Central', () => {
  const d = decidirObjetoDaCamera({ id: 'c', detectionZones: [LINHA] } as any, { politicaLiberaObjeto: false });
  assert.equal(d.roda, false);
});

test('escopo: sem linhas, comportamento antigo inalterado', () => {
  assert.equal(decidirObjetoDaCamera({ id: 'c', detectionZones: [] } as any, { politicaLiberaObjeto: true }).motivo, 'sem-linha-desenhada');
  assert.equal(decidirObjetoDaCamera({ id: 'c', detectionZones: [LINHA_ALERTA], objectMode: 'nunca' } as any, { politicaLiberaObjeto: true }).motivo, 'desligado-pelo-operador');
  assert.equal(decidirObjetoDaCamera({ id: 'c', detectionZones: [LINHA_ALERTA] } as any, { politicaLiberaObjeto: true }).motivo, 'linha-de-perimetro');
});

test('aviso: linha de contagem não cala aviso de objeto da câmera', () => {
  const meta = { bbox: [10, 10, 50, 100], frameWidth: 640, frameHeight: 360 };
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED', meta, [LINHA]), true);
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED', meta, [LINHA_ALERTA]), false);
});

test('validação de zonas: campos de contagem só em linha', () => {
  assert.doesNotThrow(() => validarZonasDeDeteccao([LINHA]));
  assert.throws(() => validarZonasDeDeteccao([{ id: 'a', name: 'A', kind: 'include', points: [[0, 0], [1, 0], [1, 1]], uso: 'contagem' }]));
});

test('duplicate keys in a batch retain the largest absolute total', () => {
  const b = { minuteStart: '2026-11-10T15:00:00Z', lineId: 'porta', classLabel: 'person', direction: 'in', count: 7 };
  const result = validarLote({ session: SESSAO, buckets: [b, { ...b, count: 3 }, { ...b, count: 9 }] }, linhasDeContagem([LINHA]), AGORA);
  assert.equal(result.baldes.length, 1);
  assert.equal(result.baldes[0].count, 9);
});
