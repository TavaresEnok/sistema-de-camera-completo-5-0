import { envNumber } from '../../common/config/env-number.helper';

// 'original' = "máxima qualidade": serve o stream PRINCIPAL da câmera em
// PASSTHROUGH (sem transcode, inclusive H.265). H.264 pode usar WebRTC; H.265
// original usa HLS porque o WHEP dos aplicativos não negocia HEVC. Em ambos os
// casos o dispositivo decodifica o vídeo e o servidor não faz encode.
// `grid-hevc` usa a mesma fonte leve de `grid`, mas preserva o codec recebido.
// Ele tem path próprio para poder coexistir com o fallback H.264 sem que dois
// navegadores reconfigurem o mesmo path um por cima do outro.
// Perfis com `-audio` preservam o vídeo do perfil base, mas normalizam apenas
// a trilha de áudio em Opus. Assim uma grade mutada não abre FFmpeg por tile.
export type LiveViewMode = 'grid' | 'grid-audio' | 'grid-hevc' | 'original' | 'original-audio';

// TILE DE MOSAICO NÃO É TELA CHEIA — e o bitrate é o que chega no espectador.
//
// O tile ocupa ~300×200 px na tela; entregar 1280×720 a 1800 kbps era mandar
// resolução que o navegador joga fora no downscale e bitrate que ele não
// consegue engolir. Com 21 tiles isso são ~38 Mbps DE DESCIDA para o cliente.
// MEDIDO no MediaMTX quando o link não dá conta: "reader is too slow,
// discarding 216 frames" — o servidor descarta quadros porque o navegador não
// consome. O operador vê exatamente o que foi relatado: fps despencando,
// tela congelando e o player reconectando "infinitamente".
//
// 640×360 já é mais do que o tile mostra, e 700 kbps sustenta essa resolução
// com folga em H.264. A conta do mosaico cai de ~38 Mbps para ~15 Mbps, e
// quem abre uma câmera em tela cheia continua recebendo o perfil grande
// (`original`), que não passa por aqui.
// FLUIDEZ x BANDA: por que o FPS voltou a 20 e a resolução NÃO.
//
// A redução acima foi feita quando o mosaico congelava. Só que a congestão
// tinha outra causa, corrigida depois: cada tile abria até 4 sessões WebRTC da
// MESMA câmera (ver "sessão WebRTC órfã"), multiplicando a descida por 4. Com
// aquilo de pé, nenhum valor aqui seria suficiente; com aquilo resolvido, o
// orçamento sobrou.
//
// O operador percebe FLUIDEZ, não pixel: num tile de ~300×200 a diferença
// entre 640 e 1280 de largura é invisível (o navegador descarta no downscale),
// mas 15 fps contra 20 aparece como movimento "picotado". FPS também é o
// parâmetro mais BARATO em banda — subir 15→20 pede ~1/3 a mais de bitrate na
// mesma resolução, enquanto dobrar a largura pediria ~4×.
//
// Daí a escolha: devolve os 20 fps (o que foi notado em produção), mantém
// 640×360 (o que de fato cortou os ~38 Mbps para o navegador) e acompanha o
// bitrate para sustentar a taxa. Mosaico de 21 tiles ≈ 19 Mbps — metade do
// que causava o "reader is too slow", com a fluidez de volta.
//
// Tudo ajustável sem deploy: se o link de algum cliente não aguentar, baixe
// GRID_LIVE_TARGET_FPS/GRID_LIVE_BITRATE_KBPS por env em vez de editar código.
export const GRID_LIVE_MAX_WIDTH = envNumber('GRID_LIVE_MAX_WIDTH', 640, {
  min: 320, max: 1920, integer: true,
});
export const GRID_LIVE_MAX_HEIGHT = envNumber('GRID_LIVE_MAX_HEIGHT', 360, {
  min: 180, max: 1080, integer: true,
});
export const GRID_LIVE_TARGET_FPS = envNumber('GRID_LIVE_TARGET_FPS', 20, {
  min: 5, max: 30, integer: true,
});
/** Bitrate do tile de mosaico, em kbps. Ver comentário acima. */
export const GRID_LIVE_BITRATE_KBPS = envNumber('GRID_LIVE_BITRATE_KBPS', 900, {
  min: 200, max: 8000, integer: true,
});
export const INSTANT_LIVE_MIN_BITRATE_KBPS = envNumber('INSTANT_LIVE_MIN_BITRATE_KBPS', 400, {
  min: 200, max: 2000, integer: true,
});
export const INSTANT_LIVE_MAX_BITRATE_KBPS = envNumber('INSTANT_LIVE_MAX_BITRATE_KBPS', 700, {
  min: 300, max: 2000, integer: true,
});

/**
 * Orçamento do modo Instantâneo.
 *
 * Um teto fixo não basta: uma câmera VBR pode reduzir o original durante uma
 * cena parada e tornar um encode leve de taxa fixa maior que o Full HD. Quando
 * conhecemos a taxa da fonte, reduzimos pela raiz da proporção de pixels (uma
 * aproximação conservadora para H.264). A telemetria instantânea da câmera pode
 * despencar em cenas paradas; por isso ela nunca reduz o encode abaixo do piso
 * visual seguro. Sem telemetria da fonte usamos 600 kbps.
 */
export function resolveInstantBitrateKbps(input: {
  sourceBitrateKbps?: number | null;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  outputWidth?: number;
  outputHeight?: number;
  ceilingKbps?: number;
}) {
  const ceiling = Math.max(64, Math.round(Number(input.ceilingKbps) || INSTANT_LIVE_MAX_BITRATE_KBPS));
  const sourceBitrate = Number(input.sourceBitrateKbps);
  if (!Number.isFinite(sourceBitrate) || sourceBitrate <= 0) {
    return Math.min(600, ceiling);
  }

  const sourcePixels = Number(input.sourceWidth) * Number(input.sourceHeight);
  const outputPixels = Number(input.outputWidth ?? GRID_LIVE_MAX_WIDTH)
    * Number(input.outputHeight ?? GRID_LIVE_MAX_HEIGHT);
  const pixelFactor = Number.isFinite(sourcePixels) && sourcePixels > 0
    && Number.isFinite(outputPixels) && outputPixels > 0
    ? Math.min(0.65, Math.max(0.2, Math.sqrt(Math.min(1, outputPixels / sourcePixels))))
    : 0.5;
  const proportional = Math.floor(sourceBitrate * pixelFactor);
  const belowOriginal = Math.floor(sourceBitrate * 0.7);

  // Não tente ser menor que um original já comprimido demais sacrificando a
  // imagem: 95 kbps em 640×360 @20 produziu macroblocos severos em produção.
  // Nessa situação rara a qualidade mínima vence a economia de banda.
  const minimum = Math.min(INSTANT_LIVE_MIN_BITRATE_KBPS, ceiling);
  return Math.min(ceiling, Math.max(minimum, Math.min(proportional, belowOriginal)));
}

export function normalizeLiveViewMode(value?: string | null): LiveViewMode {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'grid') return 'grid';
  if (v === 'grid-audio') return 'grid-audio';
  if (v === 'grid-hevc') return 'grid-hevc';
  if (v === 'original') return 'original';
  if (v === 'original-audio') return 'original-audio';
  return 'original';
}

export function resolveGridLiveProfile(input?: {
  detectedWidth?: number | null;
  detectedHeight?: number | null;
  streamWidth?: number | null;
  streamHeight?: number | null;
}) {
  const widthCandidate = input?.detectedWidth ?? input?.streamWidth ?? GRID_LIVE_MAX_WIDTH;
  const heightCandidate = input?.detectedHeight ?? input?.streamHeight ?? GRID_LIVE_MAX_HEIGHT;

  return {
    width: Math.max(1, Math.min(GRID_LIVE_MAX_WIDTH, Number(widthCandidate) || GRID_LIVE_MAX_WIDTH)),
    height: Math.max(1, Math.min(GRID_LIVE_MAX_HEIGHT, Number(heightCandidate) || GRID_LIVE_MAX_HEIGHT)),
    fps: GRID_LIVE_TARGET_FPS,
  };
}

// DE ONDE A GRADE PUXA A IMAGEM — escolha por instalação (GRID_SOURCE_PROFILE).
//
//  · `sub` (padrão): sempre o stream 2 da câmera. Leve, e sem conversão quando
//    já vem em H.264. É o que segura 30 câmeras H.265 num servidor de 8 núcleos.
//  · `camera`: a grade segue a "Fonte da imagem" do cadastro — Original usa o
//    stream 1; Econômico, o stream 2. Pedido do dono (15/09/2026, Vibe): o
//    stream 2 fica para o Instantâneo. Antes o seletor do cadastro dizia
//    "Original usa o perfil principal" e a grade ignorava.
//
// CUSTO: stream 1 em H.265 obriga converter para o navegador — medido na Vibe,
// ~1,2 núcleo por câmera 2304×1296. Ligue só onde a conta fecha.
// A variante com áudio segue a mesma fonte da grade sem áudio.
export type GridSourcePolicy = 'sub' | 'camera';

export function parseGridSourcePolicy(raw: string | null | undefined): GridSourcePolicy {
  return String(raw ?? '').trim().toLowerCase() === 'camera' ? 'camera' : 'sub';
}

/** A grade deve usar o perfil de live do cadastro em vez de procurar o stream 2? */
export function gridFollowsCameraProfile(mode: LiveViewMode, policy: GridSourcePolicy): boolean {
  return policy === 'camera' && (mode === 'grid' || mode === 'grid-hevc' || mode === 'grid-audio');
}

/**
 * O stream 2 tem FORMATO diferente do principal? (ex.: 640×480 4:3 contra 1920×1080 16:9)
 *
 * Na grade isso vira tarja preta: o tile é 16:9 e o vídeo nunca é cortado. O
 * operador vê a câmera "encolhida" e ninguém é avisado — medido em 15/09/2026
 * em 3 câmeras da instalação principal e 2 da Vibe. O conserto está na câmera,
 * mas usuário não vai fazê-lo; então a grade usa o principal nesses casos.
 *
 * Medida ausente ou inválida responde FALSO: sem prova, nada muda.
 */
export function streamDiffersInAspect(
  sub: { width?: number | null; height?: number | null } | null | undefined,
  main: { width?: number | null; height?: number | null } | null | undefined,
  tolerance = 0.05,
): boolean {
  const values = [sub?.width, sub?.height, main?.width, main?.height].map(Number);
  if (!values.every((n) => Number.isFinite(n) && n > 0)) return false;
  const [sw, sh, mw, mh] = values;
  return Math.abs((sw / sh) / (mw / mh) - 1) > tolerance;
}

/**
 * Trocar a GRADE do stream 2 para o principal por causa do formato vale a pena?
 *
 * Só quando o principal é H.264 — aí a grade o repassa sem conversão, custo
 * zero, e a tarja some. Se o principal é H.265, NÃO troca:
 *
 *   · o navegador não toca H.265, então a grade teria de CONVERTER o principal
 *     inteiro (1080p ou mais) para cada câmera: caro;
 *   · e o H.265 de câmera barata vem sujo com frequência. Medido em 18/09/2026
 *     na IBTelecom (Grupo Flash Cam-05, Dahua): o principal H.265 chegava com
 *     "Error constructing the frame RPS", o conversor não montava nenhum quadro,
 *     o MediaMTX desistia a cada ~18 s e o tile ficava PRETO a 0 fps — enquanto
 *     o stream 2 (H.264 704×480) funcionava perfeitamente. Esta regra, na
 *     primeira versão, trocou uma imagem boa por nenhuma para evitar uma tarja.
 *
 * Tarja preta é um defeito estético; tela preta é perda de monitoramento. Na
 * dúvida (codec do principal desconhecido), também não troca.
 */
export function gradeDeveUsarPrincipalPorFormato(input: {
  subDiffersInAspect: boolean;
  mainCodec: string | null | undefined;
  mainIsHevc: boolean | null | undefined;
}): boolean {
  if (!input.subDiffersInAspect) return false;
  if (input.mainIsHevc === true) return false;
  const codec = String(input.mainCodec ?? '').trim().toLowerCase();
  return codec === 'h264' || codec === 'avc' || codec === 'avc1';
}
