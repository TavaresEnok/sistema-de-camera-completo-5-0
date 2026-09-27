import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLASSES_DE_GRAVACAO, alternarClasse, resumoDeClasses } from '../src/lib/classes-de-gravacao.ts';

// ── "NÃO SÓ PARA A CAM-09" ──────────────────────────────────────────────────
//
// O modo "Pessoa ou veículo" nasceu completo no backend e presente em UMA das
// TRÊS telas que editam gravação. Para quem edita pela lista de câmeras — que é
// por onde se edita no dia a dia — a opção simplesmente não existia. A
// conclusão do dono foi a certa: "isso não pode ser só da Cam-09, tem que virar
// uma opção".
//
// Uma opção que aparece em uma tela de três não é um recurso do sistema; é um
// recurso de uma tela. Estes testes existem para essa regressão não voltar em
// silêncio — e ela volta em silêncio, porque nada quebra: a tela só deixa de
// oferecer a escolha.

// ── NADA MARCADO = PADRÃO, NUNCA "NADA GRAVA" ───────────────────────────────

test('nada marcado significa pessoa e veículos, não "não gravar nada"', () => {
  // A regra mais cara de errar: a coluna nasce VAZIA em toda câmera existente.
  // Se vazio significasse "nenhuma classe", a atualização emudeceria toda
  // câmera já em modo objeto — falha silenciosa num sistema de segurança.
  assert.match(resumoDeClasses([]), /pessoa e veículos/);
  assert.match(resumoDeClasses([]), /padrão/);
});

test('com escolha, o texto diz que SÓ aquilo grava', () => {
  assert.match(resumoDeClasses(['person']), /Só esta classe/);
  assert.match(resumoDeClasses(['person', 'car']), /Só estas classes/);
});

test('alternar devolve lista nova e nunca muta a original', () => {
  const original = ['person'];
  assert.deepEqual(alternarClasse(original, 'car'), ['person', 'car']);
  assert.deepEqual(alternarClasse(original, 'person'), []);
  assert.deepEqual(original, ['person'], 'mutação silenciosa quebraria o estado do React');
});

// ── A LISTA DA TELA É GÊMEA DA DO BACKEND ───────────────────────────────────

test('toda classe oferecida na tela é aceita pelo DTO da API', () => {
  // Divergência aqui = o operador marca uma classe, salva e toma erro de
  // validação — ou pior, fica com uma câmera que nunca grava.
  const dto = readFileSync('../api/src/cameras/dto/update-camera.dto.ts', 'utf8');
  for (const { valor } of CLASSES_DE_GRAVACAO) {
    assert.ok(dto.includes(`'${valor}'`), `a API não aceita a classe '${valor}' que a tela oferece`);
  }
});

test('a lista cobre pessoa e os veículos que importam a um VMS', () => {
  const valores = CLASSES_DE_GRAVACAO.map((c) => c.valor);
  for (const esperada of ['person', 'car', 'motorcycle', 'bus', 'truck', 'bicycle']) {
    assert.ok(valores.includes(esperada as any), `falta ${esperada}`);
  }
});

// ── AS TRÊS TELAS QUE EDITAM GRAVAÇÃO ───────────────────────────────────────

const TELAS = [
  { arquivo: 'src/components/CameraEditSheet.tsx', nome: 'edição rápida da lista' },
  { arquivo: 'src/pages/CamerasPage.tsx', nome: 'assistente de nova câmera' },
];

for (const { arquivo, nome } of TELAS) {
  test(`${nome}: oferece o modo objeto`, () => {
    const src = readFileSync(arquivo, 'utf8');
    assert.match(src, /value="object"|value: 'object'/, `${arquivo} não oferece o modo`);
  });

  test(`${nome}: deixa escolher as classes`, () => {
    const src = readFileSync(arquivo, 'utf8');
    assert.ok(src.includes('SeletorDeClassesDeGravacao'), `${arquivo} não mostra o seletor`);
    assert.ok(src.includes('recordingObjectClasses'), `${arquivo} não envia as classes`);
  });

  test(`${nome}: união de tipos não exclui 'object'`, () => {
    // Uma união desatualizada faz o TypeScript recusar o modo — e o sintoma
    // aparece longe daqui, como opção que "não salva".
    const src = readFileSync(arquivo, 'utf8');
    const incompletas = src
      .split('\n')
      .filter((l) => /recordingMode.*'continuous'.*'motion'/.test(l) && !l.includes("'object'"));
    assert.deepEqual(incompletas, [], `união sem 'object': ${incompletas[0]?.trim()}`);
  });
}

// ── CÂMERA EM MODO OBJETO É UMA CÂMERA ARMADA ───────────────────────────────

test('o selo da lista não mostra a câmera em modo objeto como ociosa', () => {
  const src = readFileSync('src/store/vmsDataStore.ts', 'utf8');
  assert.match(src, /recordingMode === 'motion' \|\| recordingMode === 'object'/);
  assert.match(src, /recordingMode: 'continuous' \| 'motion' \| 'object'/, 'o tipo Camera precisa conhecer o modo');
});

test('o botão de armar da lista reconhece o modo objeto', () => {
  // Sem isto o botão trata a câmera como desarmada, e o clique dispara
  // /recording/motion — que reescrevia o modo dela para 'motion'.
  const src = readFileSync('src/pages/CamerasPage.tsx', 'utf8');
  const inicio = src.indexOf('const isMotionRecordingMode');
  assert.notEqual(inicio, -1, 'isMotionRecordingMode sumiu — reveja este teste');
  const bloco = src.slice(inicio, src.indexOf('const isMotionRecordingActive'));
  assert.ok(bloco.includes("'object'"), 'o botão volta a apagar o modo objeto ao armar');
});
