import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rotuloDoGatilhoDeObjeto,
  descricaoDoGatilhoDeObjeto,
  podeUsarGatilhoDeObjeto,
  classesOferecidas,
  classesEfetivas,
  podeNuncaProcurarObjeto,
} from '../src/lib/gatilho-de-objeto.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Relatado em 14/08/2026, com a Central liberando SOMENTE "Pessoa":
//
//   "eu habilitei apenas pessoa na central mas na aplicação principal aparece
//    pessoa e veiculos, e mesmo se detecção de objeto estiver desabilitada
//    ainda aparece na camera detecção de pessoa e veiculos"
//
// Três defeitos: rótulo fixo em 3 telas, opção oferecida sem liberação, e o
// conjunto padrão do backend ignorando o que a Central liberou.
// ─────────────────────────────────────────────────────────────────────────────

test('só pessoa liberada → o rótulo diz PESSOA, não "pessoa ou veículo"', () => {
  assert.equal(rotuloDoGatilhoDeObjeto(['person']), 'Pessoa');
  assert.doesNotMatch(rotuloDoGatilhoDeObjeto(['person']), /ve[íi]culo/i);
});

test('pessoa + vários veículos vira "Pessoa ou veículo"', () => {
  // Enumerar tudo não cabe no seletor e ninguém lê; agrupar é o resumo honesto.
  assert.equal(rotuloDoGatilhoDeObjeto(['person', 'car', 'motorcycle']), 'Pessoa ou veículo');
});

test('pessoa + UM veículo nomeia o veículo — é mais preciso e cabe', () => {
  assert.equal(rotuloDoGatilhoDeObjeto(['person', 'car']), 'Pessoa ou Carro');
});

test('só veículo, sem pessoa, não inventa pessoa', () => {
  assert.equal(rotuloDoGatilhoDeObjeto(['car']), 'Carro');
  assert.equal(rotuloDoGatilhoDeObjeto(['car', 'truck']), 'veículo');
});

test('classe fora do grupo aparece pelo nome', () => {
  assert.equal(rotuloDoGatilhoDeObjeto(['person', 'dog']), 'Pessoa ou cachorro');
});

test('nenhuma classe liberada não vira rótulo mentiroso', () => {
  assert.equal(rotuloDoGatilhoDeObjeto([]), 'Objeto reconhecido pela IA');
  assert.equal(rotuloDoGatilhoDeObjeto(null), 'Objeto reconhecido pela IA');
  assert.equal(rotuloDoGatilhoDeObjeto(undefined), 'Objeto reconhecido pela IA');
});

test('a descrição acompanha o rótulo, e não promete o que não foi liberado', () => {
  assert.equal(descricaoDoGatilhoDeObjeto(['person']), 'Só grava quando a IA confirmar pessoa.');
  assert.match(descricaoDoGatilhoDeObjeto(['person', 'car']), /pessoa ou carro/);
  assert.doesNotMatch(descricaoDoGatilhoDeObjeto(['person']), /ve[íi]culo|carro/i);
});

test('sem liberação o gatilho NÃO pode ser usado, e diz o caminho', () => {
  // O defeito relatado: a opção aparecia mesmo desabilitada na Central, e quem
  // escolhesse ficava com uma câmera que nunca grava.
  const r = podeUsarGatilhoDeObjeto([]);
  assert.equal(r.pode, false);
  assert.match(r.motivo!, /Movimento/, 'não oferece a alternativa que funciona');
  assert.match(r.motivo!, /suporte/, 'não diz como liberar');
});

test('com liberação, pode', () => {
  assert.equal(podeUsarGatilhoDeObjeto(['person']).pode, true);
  assert.equal(podeUsarGatilhoDeObjeto(['person']).motivo, null);
});

test('o seletor por câmera só oferece o que a instalação tem', () => {
  // Oferecer "Carro" numa instalação só de pessoa seria oferecer uma escolha
  // que nunca acontece: a IA não emite aquela classe.
  assert.deepEqual(classesOferecidas(['person']), ['person']);
  assert.deepEqual(classesOferecidas([]), []);
});

test('escolha VAZIA significa "todas as liberadas", não o conjunto histórico', () => {
  // É aqui que morria a promessa de veículo: o padrão do backend era
  // pessoa+bicicleta+carro+moto+ônibus+caminhão, sem olhar o liberado.
  assert.deepEqual(classesEfetivas([], ['person']), ['person']);
  assert.deepEqual(classesEfetivas(null, ['person', 'car']), ['person', 'car']);
});

test('escolha da câmera é cortada pelo que a instalação liberou', () => {
  // Câmera configurada com carro ANTES de a Central restringir para só pessoa
  // não pode continuar esperando um evento de carro que nunca virá.
  assert.deepEqual(classesEfetivas(['person', 'car'], ['person']), ['person']);
  assert.deepEqual(classesEfetivas(['car'], ['person']), [], 'nada em comum = nada grava');
});

test('normaliza caixa e espaço em todas as entradas', () => {
  assert.equal(rotuloDoGatilhoDeObjeto([' Person ', 'CAR']), 'Pessoa ou Carro');
  assert.deepEqual(classesEfetivas([' PERSON '], ['person']), ['person']);
});

test('duplicata não duplica o rótulo', () => {
  assert.equal(rotuloDoGatilhoDeObjeto(['person', 'person']), 'Pessoa');
});

// ── As TRÊS telas seguem a mesma fonte ──────────────────────────────────────
// O defeito nasceu de o texto estar escrito à mão em cada uma. Estes testes
// garantem que nenhuma volte a inventar rótulo.

import { readFileSync } from 'node:fs';
const ler = (c: string) => readFileSync(c, 'utf8');

const TELAS = [
  'src/components/CameraEditSheet.tsx',
  'src/pages/CamerasPage.tsx',
];

test('nenhuma tela escreve "Pessoa ou veículo" à mão', () => {
  for (const tela of TELAS) {
    // Tira comentário de bloco TAMBÉM (`/* … */` e `{/* … */}` do JSX): a
    // primeira versão deste teste só filtrava linhas iniciadas por `//` e
    // reprovava o próprio comentário que EXPLICA por que o rótulo saiu.
    const fonte = ler(tela)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    assert.doesNotMatch(fonte, /["'`]Pessoa ou ve[íi]culo/,
      `${tela} voltou a cravar o rótulo — mente quando a Central libera outra coisa`);
  }
});

test('as três derivam o rótulo do que a Central liberou', () => {
  for (const tela of TELAS) {
    const fonte = ler(tela);
    assert.match(fonte, /rotuloDoGatilhoDeObjeto\(/, `${tela} não usa o rótulo derivado`);
    assert.match(fonte, /podeUsarGatilhoDeObjeto\(/, `${tela} não checa se o gatilho é oferecível`);
    assert.match(fonte, /useClassesLiberadas\(/, `${tela} não busca as classes liberadas`);
  }
});

test('o backend cruza a escolha da câmera com o liberado', () => {
  const helper = ler('../api/src/cameras/helpers/gatilho-de-gravacao.helper.ts');
  assert.match(helper, /classesEfetivasDeGravacao/, 'sem o cruzamento, a câmera fica muda esperando classe que a IA não emite');
  const controller = ler('../api/src/cameras/cameras.controller.ts');
  assert.match(controller, /classesLiberadasNaInstalacao/, 'o gatilho não recebe o que a Central liberou');
});

// ── A contradição que o dono achou olhando as duas telas ────────────────────

test('"Nunca" não é oferecido onde a GRAVAÇÃO depende do objeto', () => {
  // Marcar "Nunca" numa câmera que só grava com objeto confirmado a deixaria
  // sem gravar NADA. O backend já ignora a escolha nesse caso; a tela deixa de
  // oferecer, para não mostrar opção que o servidor descarta.
  const r = podeNuncaProcurarObjeto({ recordingMode: 'object' });
  assert.equal(r.pode, false);
  assert.match(r.motivo!, /sem gravar nada/i, 'não explica a consequência');
  assert.match(r.motivo!, /modo de gravação/i, 'não diz o que mudar primeiro');
});

test('"Nunca" continua disponível nos outros modos de gravação', () => {
  for (const modo of ['motion', 'continuous', 'manual', undefined, null]) {
    assert.equal(podeNuncaProcurarObjeto({ recordingMode: modo }).pode, true,
      `"Nunca" sumiu em recordingMode=${modo} — ele existe para poupar servidor`);
  }
});

test('a tela consulta a trava, e o backend concorda com ela', () => {
  const painel = ler('src/components/PainelDeCamerasDaIa.tsx');
  assert.match(painel, /podeNuncaProcurarObjeto\(/, 'a tela não consulta a trava');
  const helper = ler('../api/src/cameras/../ai/helpers/escopo-de-objeto.helper.ts');
  const posObjeto = helper.indexOf("motivo: 'gravacao-por-objeto'");
  const posNunca = helper.indexOf("motivo: 'desligado-pelo-operador'");
  assert.ok(posObjeto > 0 && posNunca > 0);
  assert.ok(posObjeto < posNunca,
    'gravação por objeto precisa ser avaliada ANTES de "nunca" — senão a câmera fica muda');
});
