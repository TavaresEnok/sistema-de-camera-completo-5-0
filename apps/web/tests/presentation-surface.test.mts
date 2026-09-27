import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');

test('marca visível usa S2Cam e não exibe versão fictícia', () => {
  assert.match(read('index.html'), /<title>S2Cam<\/title>/);
  assert.doesNotMatch(read('src/pages/LoginPage.tsx'), /v2\.4\s*·\s*Local/);
  assert.match(read('src/lib/product-brand.ts'), /PRODUCT_NAME = 'S2Cam'/);
});

test('nenhuma tela oferecida ao operador finge ter conteúdo que não tem', () => {
  // Este teste começou como uma lista de páginas a esconder do menu, porque
  // eram casca. Todas foram corrigidas (2026-08-07):
  //   /wall          — a rota passou a ligar o modo mural REAL do /live, em vez
  //                    de desenhar 16 retângulos pretos sem player nenhum;
  //   /events        — "Reconhecer" passou a chamar POST /cameras/incidents/:id/ack
  //                    (antes só marcava num Set local e sumia ao recarregar);
  //   /investigation — os "players" (grade de fundo, relógio parado, barra fixa
  //                    em 72%) e a régua de blocos codificados viraram links
  //                    para a Reprodução no instante em análise e uma régua
  //                    desenhada com os eventos reais.
  //
  // Agora todas estão no menu, e o que o teste protege é a REGRA que as trouxe
  // até aqui: tela oferecida ao operador não simula conteúdo. Numa interface de
  // VMS, um quadro que parece vídeo ou uma régua que parece cobertura levam
  // alguém a concluir que reviu uma cena que nunca foi exibida.
  const simulacoes: Array<[string, RegExp, string]> = [
    ['src/pages/InvestigationPage.tsx', /width:\s*'72%'/, 'barra de progresso fixa'],
    ['src/pages/InvestigationPage.tsx', /left-\[\d+%\]\s+right-\[\d+%\]/, 'bloco de régua em posição codificada'],
    ['src/pages/EventsPage.tsx', /Visualização da câmera|Preview da câmera/, 'player simulado'],
    ['src/pages/WallModePage.tsx', /aspect-video|statusDot/, 'maquete de mural'],
  ];
  // Comentários citam os padrões antigos para explicar a correção — o que
  // importa é que não estejam mais no CÓDIGO.
  const semComentarios = (texto: string) => texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((linha) => !linha.trim().startsWith('//')).join('\n');
  for (const [arquivo, padrao, oque] of simulacoes) {
    assert.doesNotMatch(semComentarios(read(arquivo)), padrao, `${arquivo}: ${oque}`);
  }
});

test('interfaces de câmera não oferecem agenda sem executor', () => {
  assert.doesNotMatch(read('src/components/CameraEditSheet.tsx'), /label:\s*'Agendada'/);
  assert.doesNotMatch(read('src/pages/CamerasPage.tsx'), /<SelectItem value="schedule"/);
  assert.match(read('src/components/CameraEditSheet.tsx'), /Agenda ainda não está disponível/);
});

test('PTZ permite tentar o controle em toda câmera ativa', () => {
  const ptz = read('src/pages/PTZPage.tsx');
  assert.match(ptz, /filter\(\(camera\) => camera\.enabled\)/);
  assert.doesNotMatch(ptz, /camera\.enabled && camera\.ptzCapable/);
  assert.match(ptz, /placeholder="Selecione uma câmera"/);
});

test('páginas sem função não voltam por engano e o mapa real permanece disponível', () => {
  // Removidas a pedido do dono (2026-08-07), com motivo cada uma:
  //   /map foi reintroduzido em 27/08/2026 usando SiteMapLayout, planta SVG,
  //   posições persistidas e player real. Não pertence mais a esta lista.
  //   /evidence     — o download do vídeo já existe na Reprodução;
  //   /reports      — não havia módulo de relatórios, só exportação de CSV;
  //   /app-builder  — gerar APK é exclusividade da DRAC Central, não da
  //                   instalação (cada instalação gerando o próprio APK
  //                   quebra a assinatura única por cliente).
  //
  // Este teste existe porque as três primeiras já tinham sido "reintroduzidas"
  // uma vez: estavam sem rota, foram achadas numa auditoria e voltaram ao menu.
  // Sem guarda, o mesmo caminho se repete na próxima varredura de código morto.
  const rotasRemovidas = ['/evidence', '/reports', '/app-builder'];
  const arquivos = ['src/App.tsx', 'src/components/Sidebar.tsx', 'src/layouts/AppLayout.tsx'];
  for (const arquivo of arquivos) {
    const fonte = read(arquivo)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((linha) => !linha.trim().startsWith('//')).join('\n');
    for (const rota of rotasRemovidas) {
      assert.doesNotMatch(fonte, new RegExp(`['"\`]${rota}['"\`]`), `${arquivo} voltou a referenciar ${rota}`);
    }
  }
  assert.match(read('src/App.tsx'), /path="\/map"/);
  assert.match(read('src/pages/MapPage.tsx'), /LiveStreamPlayer/);
  assert.match(read('src/pages/MapPage.tsx'), /map-layouts/);
  for (const pagina of ['EvidencePage', 'ReportsPage', 'AppBuilderPage']) {
    assert.throws(() => read(`src/pages/${pagina}.tsx`), `src/pages/${pagina}.tsx foi recriada`);
  }
});

// ── §5 no MAPA ──────────────────────────────────────────────────────────────
//
// Defeito real (27/08/2026): o mapa recebia 29 câmeras posicionadas por
// ESTIMATIVA DE IP — todas em dois pontos, que são saídas do provedor — e
// espalhava os marcadores num leque de ~130 m "só para ficarem clicáveis".
// Quem olhava via 25 pinos distribuídos por um bairro e concluía que o sistema
// sabia onde cada câmera estava. Num sistema de segurança isso manda gente a um
// endereço que não significa nada.
//
// O teste da §5 não cobria o mapa. Passou a cobrir.

test('§5 no mapa: posição estimada NÃO é espalhada para parecer medida', () => {
  const fonte = read('src/components/GeographicCameraMap.tsx');

  // O leque era feito com trigonometria sobre a coordenada real. Nenhuma das
  // duas tem o que fazer num mapa que só desenha o que o servidor mediu.
  assert.doesNotMatch(fonte, /Math\.sin\s*\(/, 'o mapa voltou a deslocar marcadores por ângulo');
  assert.doesNotMatch(fonte, /Math\.cos\s*\(/, 'o mapa voltou a deslocar marcadores por ângulo');
  assert.doesNotMatch(fonte, /radius\s*=\s*0\.\d+\s*\*/, 'o mapa voltou a abrir um leque em graus');

  // E precisa continuar agrupando pelo módulo honesto.
  // Desde 28/08 o agrupamento respeita o zoom (agruparParaZoom), mas continua
  // sendo AGRUPAMENTO — nunca deslocamento artificial de marcador.
  assert.match(fonte, /agruparPa?r?a?Z?o?o?m|agruparPorPosicao/,
    'o mapa deve AGRUPAR posições próximas, não espalhá-las');
});

test('§5 no mapa: o operador é avisado de que a posição é estimativa', () => {
  const mapa = read('src/components/GeographicCameraMap.tsx');
  const pagina = read('src/pages/MapPage.tsx');

  // No marcador: o rótulo diz, não só a cor — cor sozinha não informa quem não
  // distingue cores.
  assert.match(mapa, /estimado/, 'o marcador precisa dizer quando a posição é estimada');
  assert.match(mapa, /explicacaoDoPonto/, 'o ponto precisa explicar o que significa');

  // Na página: orientação curta, sem faixa técnica ou contagem alarmista.
  assert.match(pagina, /Verifique a localização das câmeras\./, 'a página precisa orientar a conferência');
  assert.doesNotMatch(pagina, /AvisoDeEstimativa/, 'a faixa técnica não deve voltar');
});
