import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classesEfetivasDaCamera,
  classesPermitidas,
  decidirObjetoDaCamera,
  explicarDecisao,
  normalizarConfiancaDaIa,
  normalizarModoDeObjeto,
  normalizarSensibilidadeDaIa,
  politicaDeConfirmacaoDaIa,
  temLinhaDePerimetro,
} from '../src/ai/helpers/escopo-de-objeto.helper';

// ─────────────────────────────────────────────────────────────────────────────
// Quais câmeras rodam IA de objeto. O YOLO é caro: ligá-lo nas 27 da frota
// custaria CPU o dia inteiro para responder a uma pergunta que ninguém está
// fazendo na maioria delas. E o incidente de 07/08/2026 mostrou o que acontece
// quando o servidor satura — vídeo ao vivo a 0 fps e sistema aparentemente
// morto.
//
// A regra: o custo segue a NECESSIDADE DECLARADA (a linha desenhada), não uma
// lista paralela que alguém precisa lembrar de manter.
// ─────────────────────────────────────────────────────────────────────────────

const LINHA = { id: 'l1', name: 'Portão', kind: 'line', points: [[0.5, 0.2], [0.5, 0.8]] };
const AREA = { id: 'z1', name: 'Rua', kind: 'exclude', points: [[0, 0], [1, 0], [1, 1]] };
const LIBERADO = { politicaLiberaObjeto: true };

test('AUTO: desenhar a linha JÁ É o pedido — liga sozinho', () => {
  const d = decidirObjetoDaCamera({ id: 'c1', detectionZones: [LINHA] }, LIBERADO);
  assert.equal(d.roda, true);
  assert.equal(d.motivo, 'linha-de-perimetro');
});

test('AUTO sem linha não roda — é o que evita pagar YOLO em 27 câmeras', () => {
  const d = decidirObjetoDaCamera({ id: 'c1', detectionZones: [AREA] }, LIBERADO);
  assert.equal(d.roda, false);
  assert.equal(d.motivo, 'sem-linha-desenhada');
  assert.match(explicarDecisao(d), /desenhe uma linha/i, 'o operador precisa saber COMO ligar');
});

test('apagar a linha desliga o custo sozinho', () => {
  // O ponto de amarrar ao desenho: não existe uma segunda configuração para
  // lembrar de reverter depois.
  const com = decidirObjetoDaCamera({ id: 'c1', detectionZones: [LINHA] }, LIBERADO);
  const sem = decidirObjetoDaCamera({ id: 'c1', detectionZones: [] }, LIBERADO);
  assert.equal(com.roda, true);
  assert.equal(sem.roda, false);
});

test('SEMPRE roda mesmo sem linha; NUNCA não roda nem com linha', () => {
  const sempre = decidirObjetoDaCamera({ id: 'c1', objectMode: 'sempre', detectionZones: [] }, LIBERADO);
  assert.equal(sempre.roda, true);
  assert.equal(sempre.motivo, 'sempre-ligado');

  // "Nunca" é a saída para a câmera que satura o servidor (cena movimentada
  // demais) SEM obrigar a apagar a linha que o operador quer manter desenhada.
  const nunca = decidirObjetoDaCamera({ id: 'c1', objectMode: 'nunca', detectionZones: [LINHA] }, LIBERADO);
  assert.equal(nunca.roda, false);
  assert.equal(nunca.motivo, 'desligado-pelo-operador');
});

test('A POLÍTICA DA CENTRAL É O PRIMEIRO PORTÃO', () => {
  // Sem isto, o operador ampliaria sozinho o que foi vendido.
  const d = decidirObjetoDaCamera(
    { id: 'c1', objectMode: 'sempre', detectionZones: [LINHA] },
    { politicaLiberaObjeto: false },
  );
  assert.equal(d.roda, false);
  assert.equal(d.motivo, 'politica-nao-libera');
});

test('câmera desativada ou com IA desligada não roda', () => {
  const desativada = decidirObjetoDaCamera({ id: 'c1', enabled: false, detectionZones: [LINHA] }, LIBERADO);
  assert.equal(desativada.motivo, 'camera-desativada');

  const semIa = decidirObjetoDaCamera({ id: 'c1', aiEnabled: false, detectionZones: [LINHA] }, LIBERADO);
  assert.equal(semIa.motivo, 'ia-desligada-na-camera');
});

test('linha degenerada não custeia um YOLO', () => {
  const doisPontosIguais = { ...LINHA, points: [[0.5, 0.5], [0.5, 0.5]] };
  assert.equal(temLinhaDePerimetro([doisPontosIguais]), false);
  assert.equal(temLinhaDePerimetro([{ ...LINHA, points: [[0.5, 0.2]] }]), false);
  assert.equal(temLinhaDePerimetro([{ ...LINHA, points: [[0.5, NaN], [0.5, 0.8]] }]), false);
  assert.equal(temLinhaDePerimetro([AREA]), false, 'polígono não é linha');
  assert.equal(temLinhaDePerimetro(null), false);
});

test('modo inválido cai em auto, nunca em "sempre"', () => {
  // Cair em "sempre" por causa de um dado corrompido ligaria YOLO na frota
  // inteira — exatamente o custo que este helper existe para conter.
  for (const v of ['talvez', '', null, undefined, 42, 'SEMPRE ']) {
    assert.equal(normalizarModoDeObjeto(v), 'auto', String(v));
  }
  assert.equal(normalizarModoDeObjeto('sempre'), 'sempre');
  assert.equal(normalizarModoDeObjeto('nunca'), 'nunca');
});

test('sem classes na política, a lista é VAZIA — nunca o catálogo inteiro', () => {
  // O pior erro possível aqui: passar a detectar tudo justamente quando não
  // havia permissão para nada.
  assert.deepEqual(classesPermitidas(undefined), []);
  assert.deepEqual(classesPermitidas({}), []);
  assert.deepEqual(classesPermitidas({ aiObjectClasses: [] }), []);
  assert.deepEqual(classesPermitidas({ aiObjectClasses: 'person' }), []);
});

test('classes da Central são normalizadas e deduplicadas', () => {
  assert.deepEqual(
    classesPermitidas({ aiObjectClasses: ['Person', ' person ', 'CAR', ''] }),
    ['person', 'car'],
  );
});

test('câmera pode reduzir as classes, mas nunca ampliar o que a Central liberou', () => {
  const permitidas = ['person', 'car', 'motorcycle'];
  assert.deepEqual(classesEfetivasDaCamera(permitidas, []), permitidas);
  assert.deepEqual(classesEfetivasDaCamera(permitidas, ['CAR', 'dog', 'car']), ['car']);
  assert.deepEqual(classesEfetivasDaCamera(permitidas, ['dog']), permitidas);
  assert.deepEqual(classesEfetivasDaCamera([], ['person']), []);
});

test('perfis de sensibilidade só alteram a confirmação e têm padrão seguro', () => {
  assert.equal(normalizarSensibilidadeDaIa('qualquer'), 'balanced');
  assert.deepEqual(politicaDeConfirmacaoDaIa('sensitive'), { confirmThreshold: 0.60, confirmMinFrames: 3 });
  assert.deepEqual(politicaDeConfirmacaoDaIa('balanced'), { confirmThreshold: 0.70, confirmMinFrames: 3 });
  assert.deepEqual(politicaDeConfirmacaoDaIa('precise'), { confirmThreshold: 0.78, confirmMinFrames: 4 });
});

test('confiança percentual controla o limiar REAL e respeita a faixa segura', () => {
  assert.equal(normalizarConfiancaDaIa(55), 55);
  assert.equal(normalizarConfiancaDaIa(73.6), 74);
  assert.equal(normalizarConfiancaDaIa(10), 40);
  assert.equal(normalizarConfiancaDaIa(40), 40);
  assert.equal(politicaDeConfirmacaoDaIa('balanced', 40).confirmThreshold, 0.40);
  assert.equal(normalizarConfiancaDaIa(100), 90);
  assert.equal(normalizarConfiancaDaIa(undefined, 'precise'), 78);
  assert.deepEqual(politicaDeConfirmacaoDaIa('balanced', 64), {
    confirmThreshold: 0.64,
    confirmMinFrames: 3,
  });
  assert.deepEqual(politicaDeConfirmacaoDaIa('balanced', 82), {
    confirmThreshold: 0.82,
    confirmMinFrames: 4,
  });
});

test('toda decisão tem explicação em português para o operador', () => {
  const motivos = [
    { id: 'a' }, // sem linha
    { id: 'b', detectionZones: [LINHA] },
    { id: 'c', objectMode: 'sempre' },
    { id: 'd', objectMode: 'nunca' },
    { id: 'e', enabled: false },
    { id: 'f', aiEnabled: false },
  ];
  for (const cam of motivos) {
    const texto = explicarDecisao(decidirObjetoDaCamera(cam as any, LIBERADO));
    assert.ok(texto.length > 10, JSON.stringify(cam));
    assert.doesNotMatch(texto, /YOLO|bbox|inference/i, 'jargão vazou para o operador');
  }
  assert.ok(explicarDecisao(decidirObjetoDaCamera({ id: 'x' }, { politicaLiberaObjeto: false })).length > 10);
});

// ── A CONTRADIÇÃO "GRAVA POR OBJETO" + "NUNCA PROCURAR OBJETO" ──────────────
//
// Achada pelo dono em 14/08/2026, olhando as duas telas:
//
//   "se eu ligar o objeto na camera e vir aqui e marcar nunca o que acontece?
//    isso não é erro de logica?"
//
// Era. O ramo `gravacao-por-objeto` existia justamente para impedir a câmera
// muda, mas ficava DEPOIS do teste de `nunca` e nunca era alcançado nessa
// combinação. A câmera não gerava evento de objeto e não gravava NADA — em
// silêncio, com as duas telas dizendo que estava tudo configurado.

test('gravação por objeto VENCE "nunca" — senão a câmera fica muda', () => {
  const d = decidirObjetoDaCamera(
    { id: 'c1', objectMode: 'nunca', recordingMode: 'object', detectionZones: [] },
    LIBERADO,
  );
  assert.equal(d.roda, true, 'sem isto a câmera não grava NADA e nada na tela avisa');
  assert.equal(d.motivo, 'gravacao-por-objeto');
});

test('"nunca" continua valendo quando a gravação NÃO depende do objeto', () => {
  // A função original de "Nunca" segue intacta: poupar servidor numa cena
  // movimentada, sem obrigar a apagar a linha que o operador quer manter.
  for (const modoDeGravacao of ['motion', 'continuous', 'manual', undefined]) {
    const d = decidirObjetoDaCamera(
      { id: 'c1', objectMode: 'nunca', recordingMode: modoDeGravacao, detectionZones: [LINHA] },
      LIBERADO,
    );
    assert.equal(d.roda, false, `"nunca" deixou de valer em recordingMode=${modoDeGravacao}`);
    assert.equal(d.motivo, 'desligado-pelo-operador');
  }
});

test('os portões ACIMA continuam vencendo a gravação por objeto', () => {
  // Política da Central, câmera desativada e IA desligada são portões duros:
  // gravação por objeto não pode furá-los. Sem isto, o modo de gravação viraria
  // um jeito de ampliar sozinho o que foi vendido.
  const semPolitica = decidirObjetoDaCamera(
    { id: 'c1', objectMode: 'sempre', recordingMode: 'object', detectionZones: [] },
    { politicaLiberaObjeto: false },
  );
  assert.equal(semPolitica.roda, false);
  assert.equal(semPolitica.motivo, 'politica-nao-libera');

  const iaDesligada = decidirObjetoDaCamera(
    { id: 'c1', aiEnabled: false, recordingMode: 'object', detectionZones: [] },
    LIBERADO,
  );
  assert.equal(iaDesligada.roda, false);
  assert.equal(iaDesligada.motivo, 'ia-desligada-na-camera');
});
