import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ler = (caminho: string) => readFileSync(caminho, 'utf8');
const semComentarios = (texto: string) => texto
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// FASE 1 DA REORGANIZAÇÃO DA IA (13/08/2026).
//
// A auditoria achou que a única tela em que a IA devolve valor visível — a fila
// de detecções, com foto, rótulo e clique que abre o vídeo — estava FORA do
// menu na web e DENTRO do menu no aplicativo. O mesmo cliente, nos dois
// dispositivos, via o sistema se contradizer.
//
// Estes testes travam as três decisões que resolveram isso. Todas são fáceis de
// desfazer sem querer numa refatoração, e nenhuma quebra em tempo de execução —
// só empobrece a tela em silêncio, que é o pior jeito de regredir.
// ─────────────────────────────────────────────────────────────────────────────

test('Detecções é a aba que ABRE a Inteligência', () => {
  // A ordem das abas é a ordem das perguntas: o operador abre a IA para ver o
  // que ela achou (todo dia), não para configurá-la (uma vez por câmera).
  const fonte = semComentarios(ler('src/pages/AiPage.tsx'));
  assert.match(fonte, /defaultValue="deteccoes"/, 'a Inteligência não abre em Detecções');
  const ordem = ['deteccoes', 'configurar'].map((v) => fonte.indexOf(`'${v}'`));
  assert.ok(ordem[0] >= 0 && ordem[0] < ordem[1],
    'a ordem das abas deixou de ser Detecções → Configuração');
  assert.doesNotMatch(fonte, /'diagnostico'|'ajustes'/,
    'abas técnicas voltaram ao fluxo simples do operador');
});

test('a rota /review continua de pé — o app depende dela', () => {
  // O push com deep link do aplicativo aponta para /review. Trocar a rota
  // derrubaria a notificação de alarme de quem já tem o app instalado.
  const app = semComentarios(ler('src/App.tsx'));
  assert.match(app, /path="\/review"/, 'a rota /review sumiu e o deep link do app quebra');
});

test('a fila é UM componente montado em dois lugares, não duas cópias', () => {
  // Duas cópias divergiriam: um filtro novo entraria só na aba, e quem chegasse
  // pela notificação veria uma tela diferente.
  const painel = 'src/components/PainelDeDeteccoes.tsx';
  const pagina = ler('src/pages/ReviewPage.tsx');
  const aba = ler('src/pages/AiPage.tsx');
  assert.match(pagina, /PainelDeDeteccoes/, '/review não usa o painel compartilhado');
  assert.match(aba, /PainelDeDeteccoes/, 'a aba Detecções não usa o painel compartilhado');
  assert.match(ler(painel), /\/review\/feed/, 'o painel deixou de consumir a fila do backend');
  // A página é casca fina: se voltar a ter lógica, é sinal de cópia nascendo.
  assert.ok(pagina.split('\n').length < 25, 'ReviewPage voltou a carregar lógica própria');
});

test('o cabeçalho de página só aparece na ROTA, nunca dentro da aba', () => {
  // Como aba, o cabeçalho é da Inteligência — repetir daria dois títulos.
  const aba = semComentarios(ler('src/pages/AiPage.tsx'));
  assert.match(aba, /<PainelDeDeteccoes comCabecalho=\{false\}/, 'a aba está repetindo o cabeçalho');
  const pagina = semComentarios(ler('src/pages/ReviewPage.tsx'));
  assert.doesNotMatch(pagina, /comCabecalho=\{false\}/, 'a rota perdeu o próprio cabeçalho');
});

test('o contador de não-vistas aparece no menu e não custa nada sem IA', () => {
  // `/review/unseen-count` existia desde sempre e ninguém consumia. Agora tem
  // função — mas só faz sentido onde a IA foi contratada.
  const menu = semComentarios(ler('src/components/Sidebar.tsx'));
  assert.match(menu, /useDeteccoesNaoVistas\(aiFeatureEnabled\)/,
    'o contador deve ser buscado apenas quando a IA está contratada');
  assert.match(menu, /path === '\/ia' && contador/, 'o selo não está pendurado no item da IA');
});

test('o vocabulário novo entrou nas telas de IA', () => {
  // §10 dos padrões: três termos, e só três.
  const painel = semComentarios(ler('src/components/PainelDeDeteccoes.tsx'));
  assert.doesNotMatch(painel, /\brevis[ãa]/i, 'a palavra "revisão" voltou para a tela');
  const configuracao = semComentarios(ler('src/components/ConfiguracaoFacilDaIa.tsx'));
  assert.match(configuracao, /O que identificar/, 'a seção de classes não usa o termo do vocabulário');
});

test('o fluxo comum não exibe diagnóstico técnico e explicações longas', () => {
  const ai = ler('src/pages/AiPage.tsx');
  assert.doesNotMatch(ai, /descarta sozinha|pisca|Placa de vídeo|GPU/i);
  const configuracao = ler('src/components/ConfiguracaoFacilDaIa.tsx');
  for (const essencial of ['O que identificar', 'Precisão', 'Onde identificar', 'Salvar configuração']) {
    assert.match(configuracao, new RegExp(essencial));
  }
});

// ── FASE 2: a aba Câmeras ───────────────────────────────────────────────────

test('a aba Câmeras mostra o ESTADO real, não só a configuração', () => {
  // A diferença que a auditoria apontou: "esta câmera está marcada para
  // detectar" versus "esta câmera está detectando agora". O backend já media
  // tudo isto e não havia tela.
  const painel = ler('src/components/PainelDeCamerasDaIa.tsx');
  assert.match(painel, /\/ai\/intelligence/, 'não consulta o estado real da IA');
  assert.match(painel, /inferenceFps|estadoDaIa/, 'não mostra se está mesmo analisando');
  assert.match(painel, /restart/, 'não oferece reiniciar a análise da câmera');
});

test('o estado é traduzido pelo helper, nunca montado na tela', () => {
  // Espalhar a decisão pelo JSX faria a regra divergir da versão testada.
  const painel = semComentarios(ler('src/components/PainelDeCamerasDaIa.tsx'));
  assert.match(painel, /import \{[^}]*estadoDaIa/s, 'a tela não usa o tradutor testado');
  assert.doesNotMatch(painel, /camera_ai_disabled|filtered_by_ai_env/,
    'chave de sistema vazou para a tela — §11 dos padrões');
});

test('atualiza sozinha: estado que muda em silêncio não pode ficar velho na tela', () => {
  const painel = semComentarios(ler('src/components/PainelDeCamerasDaIa.tsx'));
  assert.match(painel, /setInterval/, 'sem atualização periódica a tela mente até alguém apertar Atualizar');
});

test('desenhar linha e áreas acontece em UM lugar só', () => {
  // Eram duas telas com o mesmo componente gravando no mesmo campo, e nada
  // dizia que eram a mesma coisa.
  const painel = ler('src/components/PainelDeCamerasDaIa.tsx');
  assert.match(painel, /DetectionZonesEditor/, 'a aba Câmeras não embute o editor');
  const menu = semComentarios(ler('src/components/Sidebar.tsx'));
  assert.match(menu, /'\/perimetro'/, 'Perímetro deveria sair do MENU');
  const app = semComentarios(ler('src/App.tsx'));
  assert.match(app, /path="\/perimetro"/, 'a ROTA /perimetro não pode morrer — ainda é linkável');
});

test('o vínculo com gravação é mostrado, e o controle continua na aba Gravação', () => {
  // Mover o gatilho de lugar quebraria a memória de quem já usa; não mostrar o
  // vínculo deixaria o usuário sem entender que as duas coisas conversam.
  const painel = ler('src/components/PainelDeCamerasDaIa.tsx');
  assert.match(painel, /recordingMode === 'object'/, 'não detecta a câmera que grava por IA');
  assert.match(painel, /Grava quando a IA confirma/, 'não explica o vínculo');
  assert.doesNotMatch(painel, /recordingMode:\s*'object'/, 'a aba de IA não pode ESCREVER o gatilho');
});

// ── FASE 3: transparência ───────────────────────────────────────────────────

test('o custo aparece em número, e separa medido de estimado', () => {
  // "A detecção de objeto é cara" sem número transforma "Sempre ligado" em
  // aposta. O número sai de medida (latência × frequência), não de chute.
  const painel = ler('src/components/PainelDeCamerasDaIa.tsx');
  assert.match(painel, /descreverCusto\(/, 'a linha da câmera não mostra custo');
  assert.match(painel, /estimativa/, 'não distingue o número medido do estimado');
  assert.match(painel, /custoTotal|Custo agora/, 'não mostra o custo somado da instalação');
});

test('a placa de vídeo fica nos ajustes do servidor, fora da configuração simples', () => {
  const ai = ler('src/pages/AiPage.tsx');
  assert.doesNotMatch(ai, /gpu\/status|Placa de vídeo|NVENC|CUDA|nvidia-smi/i);
  const ajustes = ler('src/pages/SettingsPage.tsx');
  assert.match(ajustes, /GPU \/ Placa de vídeo/);
});

test('a tela simples não consulta a rota administrativa de GPU', () => {
  const ai = semComentarios(ler('src/pages/AiPage.tsx'));
  assert.doesNotMatch(ai, /gpu\/status/);
});

// ── FASE 4: procurar por objeto na Reprodução ───────────────────────────────

test('a régua filtra por objeto — e o rótulo deixou de ser jogado fora', () => {
  // O feed sempre mandou `metadata`; a Reprodução mapeava só id/hora/gravidade.
  // Sem o rótulo não há como responder "onde apareceu gente".
  const p = ler('src/pages/PlaybackPage.tsx');
  assert.match(p, /label: rotuloDoEvento\(event\.metadata\)/, 'o rótulo continua sendo descartado');
  assert.match(p, /filtrarPorObjeto\(playbackEvents, filtroDeObjeto\)/, 'a régua não aplica o filtro');
  assert.match(p, /OBJETOS_BUSCAVEIS\.map/, 'não há controle para escolher o objeto');
});

test('as DUAS montagens de evento guardam o rótulo', () => {
  // A Reprodução carrega eventos por dois caminhos (dia inteiro e por janela).
  // Se só um guardasse o rótulo, o filtro funcionaria de forma intermitente
  // conforme o operador movesse a régua — o pior tipo de defeito.
  const p = ler('src/pages/PlaybackPage.tsx');
  const ocorrencias = (p.match(/label: rotuloDoEvento/g) ?? []).length;
  assert.equal(ocorrencias, 2, `esperado 2 montagens com rótulo, achei ${ocorrencias}`);
});

test('o filtro vazio explica se o DIA estava vazio ou só o filtro', () => {
  const p = ler('src/pages/PlaybackPage.tsx');
  assert.match(p, /avisoDoFiltro/, 'não mostra o resultado do filtro ao operador');
  assert.match(p, /explicarResultado\(/, 'não usa a explicação testada');
});

// ── Lacunas fechadas depois da revisão ──────────────────────────────────────

test('ligar/desligar a IA da câmera mora na aba Câmeras', () => {
  // O achado "7 controles em 5 telas" só fica resolvido quando o interruptor
  // principal está onde o estado é mostrado. Antes a tela dizia "ligue nas
  // configurações da câmera" e não oferecia o caminho.
  const painel = ler('src/components/PainelDeCamerasDaIa.tsx');
  assert.match(painel, /alternarIa/, 'não há ação de ligar/desligar');
  assert.match(painel, /aiEnabled: ligar/, 'não escreve o campo no backend');
});

test('câmera com IA OBRIGATÓRIA não ganha botão que o servidor ignoraria', () => {
  // Oferecer o controle e ver o servidor desfazer faria o operador concluir que
  // o sistema está quebrado. A regra é gêmea da do backend.
  const painel = ler('src/components/PainelDeCamerasDaIa.tsx');
  assert.match(painel, /podeDesligarIa\(/, 'não consulta a trava');
  assert.match(painel, /IA obrigatória aqui/, 'não explica por que não há botão');
});

test('edição da câmera encaminha o desenho para o perímetro, sem outro editor', () => {
  const detalhe = ler('src/components/CameraEditSheet.tsx');
  assert.match(detalhe, /\['perimetro', 'Editar perímetro'\]/);
  assert.doesNotMatch(detalhe, /DetectionZonesEditor/);
});
