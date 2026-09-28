/// <reference types="node" />
import { formatBytes, formatDateLabel, formatDuration, formatResolution, formatTime, isOnline, localDateKey, localDayIsoRange } from '../src/utils/format';
import { normalizeServerUrl, request, setTokenRefreshHandler, setUnauthorizedHandler } from '../src/services/api';
import { authenticatedMediaUrl, isSecureMediaUrl } from '../src/services/media-urls';
import { computeDetectionRect } from '../src/utils/detection-geometry';
import { matchesPlaybackFilter, recordingKind, timelineRange } from '../src/utils/playback';
import { contrastRatio, ensureReadableText, fetchBranding } from '../src/services/branding';
import { clearStreamUrlsCache, requestCachedStreamUrls } from '../src/services/stream-urls-cache';
import { parseWhepIceServers } from '../src/services/whep-ice-servers';
import type { Camera, Recording } from '../src/types';
import { readFileSync } from 'node:fs';

import { test } from 'node:test';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

test('formatters: tempo, duração, bytes e resolução', () => {
  assert(formatTime(null) === '--:--', 'formatTime deve tratar valor vazio');
  assert(formatDuration(0) === 'em andamento', 'formatDuration deve tratar zero como em andamento');
  assert(formatDuration(90) === '1m 30s', 'formatDuration deve formatar minutos e segundos');
  assert(formatBytes(1024) === '1 KB', 'formatBytes deve formatar KB');
  assert(formatBytes(1024 * 1024) === '1.0 MB', 'formatBytes deve formatar MB');
  assert(formatResolution({ detectedWidth: 1920, detectedHeight: 1080, detectedFps: 30 } as Camera) === '1920x1080 @ 30 FPS', 'formatResolution deve incluir FPS');
});

test('android security: build bloqueia permissões e backup inseguros', () => {
  const base = JSON.parse(readFileSync('app.base.json', 'utf8')).expo;
  const blocked = new Set<string>(base.android?.blockedPermissions ?? []);
  assert(blocked.has('android.permission.SYSTEM_ALERT_WINDOW'), 'overlay deve estar bloqueado');
  assert(blocked.has('android.permission.WRITE_EXTERNAL_STORAGE'), 'storage legado deve estar bloqueado');
  assert((base.plugins ?? []).includes('./plugins/withAndroidSecurity'), 'plugin de hardening deve executar em todo prebuild');
  const plugin = readFileSync('plugins/withAndroidSecurity.js', 'utf8');
  assert(plugin.includes("android:allowBackup'] = 'false'"), 'backup Android deve ser desativado');
  assert(plugin.includes("android:requestLegacyExternalStorage'] = 'false'"), 'storage legado deve ser desativado');
});

test('cadastro de câmera: porta RTSP é automática e o preenchimento manual só aparece após falha', () => {
  const source = readFileSync('src/components/AddCameraSheet.tsx', 'utf8');
  assert(!source.includes('Configuração avançada'), 'não deve esconder dados necessários em Configuração avançada');
  assert(source.includes("const RTSP_PORT_DEFAULT = '';"), 'porta deve iniciar em modo automático, sem fingir que 554 já foi detectada');
  assert(source.includes('Porta e vídeo automáticos'), 'a tela deve explicar a detecção automática');
  assert(source.includes('manualConnectionNeeded ?'), 'falha automática deve revelar a correção manual');
  assert(source.includes('Porta RTSP'), 'a correção manual deve permitir informar a porta RTSP');
  assert(source.includes('Caminho do vídeo (se houver)'), 'a correção manual deve permitir informar o caminho do stream');
});

test('provisionamento Wi-Fi não promete pareamento proprietário inexistente', () => {
  const source = readFileSync('src/components/AddCameraSheet.tsx', 'utf8');
  assert(source.includes('Isto não é pareamento Wi-Fi automático'), 'tela deve separar guia de instalação de pareamento real');
  assert(source.includes('SDK oficial de cada fabricante'), 'dependência de driver oficial deve ficar explícita');
  assert(source.includes('QR com endereço IP ou RTSP'), 'QR genérico não pode fingir aceitar QR proprietário');
});

test('cadastro de câmera: Voltar preserva a jornada e não fecha o fluxo inteiro', () => {
  const source = readFileSync('src/components/AddCameraSheet.tsx', 'utf8');
  assert(source.includes('const historyRef = useRef<Screen[]>([]);'), 'o cadastro deve manter histórico das etapas visitadas');
  assert(source.includes("const previous = historyRef.current.pop() ?? 'home';"), 'Voltar deve recuperar a etapa anterior');
  assert(source.includes('onRequestClose={handleSystemBack}'), 'o botão físico do Android deve usar a mesma navegação');
  assert(!source.includes('onRequestClose={onClose}'), 'o botão físico não pode fechar o cadastro a partir de QR/detalhes');
  assert(source.includes('operationRef.current += 1;'), 'voltar/fechar deve invalidar respostas assíncronas atrasadas');
});

test('câmera privada: app oferece edição, endereço RTMP e exclusão confirmada', () => {
  const sheet = readFileSync('src/components/CameraManagementSheet.tsx', 'utf8');
  const list = readFileSync('src/screens/redesign/CamerasRedesign.tsx', 'utf8');
  assert(sheet.includes("method: 'PATCH'"), 'edição precisa salvar no backend');
  assert(sheet.includes("method: 'DELETE'"), 'exclusão precisa chamar o backend');
  assert(sheet.includes('/rtmp-ingest'), 'dono deve conseguir recuperar o endereço RTMP');
  assert(sheet.includes("Alert.alert(\n      'Excluir esta câmera?'"), 'exclusão destrutiva precisa de confirmação');
  assert(list.includes('cam.canSelfManage'), 'ação só deve aparecer para o proprietário autorizado');
  assert(list.includes('Editar ou excluir'), 'a ação precisa ser visível e acessível na lista e no mural');
});

test('posters usam snapshot persistente e renovação espaçada em lote', () => {
  const source = readFileSync('App.tsx', 'utf8');
  const cache = readFileSync('src/services/poster-cache.ts', 'utf8');
  assert(source.includes('&fresh=1'), 'a renovação deve solicitar um frame atual ao servidor');
  assert(source.includes('savePoster(scope, item.cameraId, url)'), 'o frame atual deve ser salvo no aparelho');
  assert(source.includes('POSTER_REFRESH_BATCH = 30'), 'uma frota grande deve renovar imagens em lotes pequenos');
  assert(cache.includes('3 * 24 * 60 * 60 * 1000'), 'o snapshot deve permanecer válido por três dias');
  assert(cache.includes('FileSystem.documentDirectory ?? FileSystem.cacheDirectory'), 'o snapshot deve preferir armazenamento persistente');
});

test('stream WHEP: Location externo nunca recebe token de reprodução', () => {
  const source = readFileSync('src/components/WebRtcVideo.tsx', 'utf8');
  assert(source.includes('resolved.origin !== original.origin'), 'sessão WHEP deve permanecer na origem autorizada');
  assert(source.includes("throw new Error('WHEP devolveu sessão em origem diferente')"), 'origem diferente deve abortar a conexão');
});

test('stream WHEP: app lê o TURN temporário antes de criar o peer', () => {
  const parsed = parseWhepIceServers(
    '<turn:177.104.156.25:3478?transport=udp>; rel="ice-server"; username="u"; credential="c"',
  );
  assert(parsed.length === 1 && parsed[0].username === 'u', 'Link TURN deve virar configuração ICE');
  const source = readFileSync('src/components/WebRtcVideo.tsx', 'utf8');
  assert(source.indexOf('discoverWhepIceServers(') < source.indexOf('new RTCPeerConnection('),
    'OPTIONS WHEP precisa acontecer antes de criar RTCPeerConnection');
  assert(!source.includes('iceServers: []'), 'app não pode descartar o TURN anunciado pelo servidor');
});

test('ao vivo recupera WebRTC congelado e abre câmera única em máxima qualidade', () => {
  const app = readFileSync('App.tsx', 'utf8');
  const whep = readFileSync('src/components/WebRtcVideo.tsx', 'utf8');
  const player = readFileSync('src/components/VideoPlayers.tsx', 'utf8');
  const live = readFileSync('src/screens/LiveScreen.tsx', 'utf8');
  const redesign = readFileSync('src/screens/redesign/LiveScreenRedesign.tsx', 'utf8');
  assert(whep.includes('pc.getStats()'), 'sessão ICE conectada precisa vigiar avanço real de mídia');
  assert(whep.includes('MEDIA_STALL_TIMEOUT_MS'), 'WebRTC congelado precisa de limite explícito');
  assert(!player.includes('30_000'), 'HLS estável não pode ser interrompido por sondagem WebRTC periódica');
  assert(live.includes('useState(true)') && redesign.includes('useState(true)'), 'tela única deve começar em máxima qualidade');
  assert(app.includes('setHdWhepUrl(whep)'), 'HD+ deve priorizar o WebRTC original em vez de forçar HLS');
  assert(app.includes("'X-S2Cam-Native-WebRTC': 'hevc'"), 'app nativo deve declarar a tentativa HEVC/WHEP ao servidor');
  assert(live.includes('whepUri={hdWhepUrl}') && redesign.includes('whepUri={hdActive ? hdWhepUrl : whepUrl}'), 'as duas telas ao vivo devem entregar WHEP no HD+');
  assert(live.includes("{hdMode ? 'Economia' : 'HD+'}") && redesign.includes("label={hdMode ? 'Economia' : 'HD+'}"), 'o botão deve mostrar a qualidade para a qual vai trocar');
});

test('login mantém os campos visíveis acima do teclado', () => {
  const login = readFileSync('src/screens/LoginScreen.tsx', 'utf8');
  const config = readFileSync('app.config.js', 'utf8');
  assert(login.includes('KeyboardAvoidingView'), 'login deve reposicionar o formulário quando o teclado abrir');
  assert(config.includes("softwareKeyboardLayoutMode: 'resize'"), 'Android deve redimensionar a janela acima do teclado');
});

test('release do app exige checkout aprovado e código commitado', () => {
  const sh = readFileSync('scripts/build-client.sh', 'utf8');
  const agent = readFileSync('scripts/build-agent.mjs', 'utf8');
  assert(sh.includes('EXPECTED_SOURCE_COMMIT'), 'builder precisa comparar o checkout com a release');
  assert(sh.includes('build recusado: o código do aplicativo possui alterações sem commit'), 'builder não pode publicar fonte suja');
  assert(agent.includes("sourceCommit completo é obrigatório"), 'agente não pode aceitar build sem release aprovada');
});

test('build-agent limpa cache CMake compartilhado e expõe a causa da falha', () => {
  const agent = readFileSync('scripts/build-agent.mjs', 'utf8');
  assert(agent.includes("git(['fetch', '--prune', 'origin']"), 'agente deve buscar uma release recém-aprovada antes de recusá-la');
  assert(agent.includes("'-name', '.cxx'"), 'agente deve remover todo cache .cxx contaminado, inclusive dentro de android/build');
  assert(agent.includes("path.join(worktree, 'node_modules')"), 'limpeza deve alcançar dependências hoisted na raiz do monorepo');
  assert(agent.includes("'install', '--frozen-lockfile', '--prefer-offline'"), 'cada release deve sincronizar dependências pelo próprio lockfile antes de compilar');
  assert(agent.includes('summarizeBuildFailure'), 'agente deve guardar um motivo útil para falhas de build');
  assert(agent.indexOf('unable to resolve module') < agent.indexOf('logo do cliente|adaptive.?icon'), 'erro de módulo deve ser classificado antes de qualquer diagnóstico de imagem');
  assert(!agent.includes("return detail.slice(0, 900)"), 'agente não deve despejar erro técnico do Gradle na interface');
  assert(agent.includes('O aplicativo anterior continua disponível'), 'falha desconhecida deve preservar e orientar em linguagem humana');
  assert(agent.includes("error: lastJob.status === 'failed'"), 'lista de clientes deve entregar a causa da última falha à Central');
});

test('white-label: ícone próprio vem da Central sem substituir a logo do cliente', () => {
  const agent = readFileSync('scripts/build-agent.mjs', 'utf8');
  assert(agent.includes('appIconBase64'), 'agente deve aceitar um ícone específico do aplicativo');
  assert(agent.includes('resetAppIcon'), 'remoção do ícone precisa voltar ao padrão sem sobrar asset antigo');
  assert(agent.includes('stageClientAppIcon'), 'ícone deve ser convertido separadamente da identidade visual');
  assert(agent.includes("['icon.png', 'adaptive-icon.png']"), 'Android precisa receber as duas variantes do launcher');
  assert(!agent.includes('iconContentCrop'), 'agente não pode alterar novamente o recorte escolhido visualmente na Central');
});

test('barra ao vivo deixa PTZ fechado, acessível e mantém as ações na ordem operacional', () => {
  const redesign = readFileSync('src/screens/redesign/LiveScreenRedesign.tsx', 'utf8');
  assert(redesign.includes("const [ptzOpen, setPtzOpen] = useState(false)"), 'PTZ não pode iniciar pressionado');
  const row = redesign.slice(redesign.indexOf('/* Barra de ações */'), redesign.indexOf('/* Feedback do PTZ */'));
  const labels = ['Ouvir', 'Capturar', 'Clipe no celular', 'Sistema: até 10 min', 'Notificar', 'HD'];
  let previous = -1;
  for (const label of labels) {
    const current = row.indexOf(label);
    assert(current > previous, `${label} deve respeitar a ordem da barra`);
    previous = current;
  }
  const hd = row.indexOf("label={hdMode ? 'Economia' : 'HD+'}");
  const ptz = row.indexOf('label="PTZ"');
  const tela = row.indexOf('label="Tela"');
  assert(hd >= 0 && ptz > hd && tela > ptz, 'PTZ autorizado deve aparecer depois da qualidade e antes da tela cheia');
  assert(row.includes('active={ptzOpen}'), 'o botão deve refletir abertura sem iniciar pressionado');
  assert(row.includes('{canPtz ? ('), 'usuário sem autorização não pode receber o botão PTZ');
});

test('PTZ respeita a permissão também em tela cheia, fecha ao sair e não desloca o pad', () => {
  const app = readFileSync('App.tsx', 'utf8');
  const redesign = readFileSync('src/screens/redesign/LiveScreenRedesign.tsx', 'utf8');
  assert(app.includes('canPtz={live.canControl !== false}'), 'a câmera controlável deve manter o caminho visual de PTZ');
  assert(redesign.includes('if (!canPtz || isPlaying) setPtzOpen(false);'), 'perder permissão ou abrir playback deve fechar PTZ');
  assert(redesign.includes('setPtzOpen(false); setFullscreen(false);'), 'sair da tela cheia não pode vazar o pad para a tela normal');
  assert(redesign.includes('ptzOpen && canPtz && !isPlaying'), 'o pad em tela cheia precisa exigir permissão');
  assert(redesign.includes('ptzOpen && canPtz ? ('), 'o pad normal precisa exigir permissão');
  assert(redesign.includes('ptzFeedbackSlot: { height: 43'), 'o aviso deve reservar espaço fixo para não fazer o pad saltar');
});

test('HD+ preserva a imagem original via HLS somente quando WHEP confirma incompatibilidade', () => {
  const app = readFileSync('App.tsx', 'utf8');
  const player = readFileSync('src/components/VideoPlayers.tsx', 'utf8');
  const redesign = readFileSync('src/screens/redesign/LiveScreenRedesign.tsx', 'utf8');
  assert(app.includes('setHdUrl(hls)'), 'a URL HLS original não pode ser descartada ao preparar HD+');
  assert(app.includes('if (!whep && !hls)'), 'HD+ deve aceitar WHEP ou HLS do mesmo stream original');
  assert(player.includes('hlsOnConfirmedWhepIncompatibility'), 'o player precisa distinguir incompatibilidade confirmada de falha transitória');
  assert(player.includes("/HTTP 400/.test(reason ?? '')"), 'somente a recusa confirmada da negociação pode abrir HLS automaticamente');
  assert(player.includes('props.uri && !whepUri'), 'quando o servidor não oferece WHEP, o original deve abrir diretamente no player nativo');
  assert(player.includes('preferredForwardBufferDuration: 1'), 'LL-HLS ao vivo não pode herdar o buffer de até 20 s do player de filmes');
  assert(player.includes('minBufferForPlayback: 0.5'), 'fallback deve começar perto da borda ao vivo');
  assert(player.includes('setHevcWebRtc(true)'), 'antes do HLS, HD+ deve testar H.265 no WebRTC do Chromium Android');
  assert(player.includes('<HevcWebRtcVideo'), 'o player experimental H.265 precisa estar ligado ao fluxo HD+');
  assert(redesign.includes('uri={hdActive ? hdUrl : streamUrl}'), 'HLS de HD+ deve receber o stream original, não o perfil reduzido');
  assert(redesign.includes('hlsOnConfirmedWhepIncompatibility={hdActive}'), 'a exceção de compatibilidade deve valer apenas no HD+');
});

test('WebRTC H.265 só assume o vídeo quando o WebView anuncia e decodifica HEVC', () => {
  const source = readFileSync('src/components/HevcWebRtcVideo.tsx', 'utf8');
  assert(source.includes("RTCRtpReceiver.getCapabilities?.('video')"), 'deve consultar os codecs reais do Android WebView');
  assert(source.includes("/video\\\\/(h265|hevc)/i"), 'deve exigir H.265/HEVC na capacidade WebRTC');
  assert(source.includes("report.framesDecoded"), 'conexão ICE sem frame não pode ser declarada ao vivo');
  assert(source.includes("resolved.origin !== original.origin"), 'Location WHEP não pode enviar token para outra origem');
  assert(source.includes('mixedContentMode="never"'), 'player não pode liberar conteúdo inseguro');
});

test('permissões do app são renovadas ao retomar e não somem por uma falha transitória', () => {
  const app = readFileSync('App.tsx', 'utf8');
  assert(app.includes('permissionsRefreshNonce'), 'o retorno ao primeiro plano deve disparar nova leitura de permissões');
  assert(app.includes("setPermissionsRefreshNonce((current) => current + 1)"), 'o app deve revalidar permissões ao voltar ao primeiro plano');
  assert(app.includes('loadCapabilities(attempt + 1)'), 'uma falha momentânea precisa tentar novamente antes de ocultar recursos');
  assert(!app.includes('const fallback = { liveView: true, playback: true, exportEvidence: false, alarmAck: false, ptzControl: false }'), 'falha de rede não pode desligar PTZ silenciosamente');
});

test('erro de PTZ usa o diagnóstico da API, inclusive para câmera sem suporte', () => {
  const app = readFileSync('App.tsx', 'utf8');
  assert(app.includes("if (data?.status === 'error') { ptzFail(data.message); return; }"), 'a mensagem classificada pela API não pode ser descartada');
  assert(app.includes("'Controle PTZ indisponível'"), 'o título deve orientar sem atribuir culpa a credenciais');
  assert(app.includes("isZoom ? 'Zoom indisponível'"), 'falha de zoom não pode afirmar que todo o PTZ está indisponível');
});

test('controles ao vivo distinguem ouvir, captura em curso e clipe de cinco minutos', () => {
  const app = readFileSync('App.tsx', 'utf8');
  const redesign = readFileSync('src/screens/redesign/LiveScreenRedesign.tsx', 'utf8');
  const icons = readFileSync('src/components/Icon.tsx', 'utf8');
  assert(icons.includes("case 'volume':"), 'áudio de reprodução deve usar alto-falante, não microfone');
  assert(redesign.includes('icon="volume"'), 'o controle de ouvir deve exibir o ícone de volume');
  assert(redesign.includes("props.snapshotBusy ? 'Capturando…' : 'Capturar'"), 'a captura precisa responder imediatamente ao toque');
  assert(app.includes('const MANUAL_CLIP_MAX_MS = 5 * 60 * 1000'), 'o clipe manual deve ter teto de cinco minutos');
  assert(app.includes("'Ela será encerrada automaticamente em 5 minutos."), 'o usuário deve conhecer o limite assim que a gravação começa');
});

test('reprodução usa controles de CFTV e abre no horário escolhido da régua', () => {
  const player = readFileSync('src/components/VideoPlayers.tsx', 'utf8');
  const live = readFileSync('src/screens/redesign/LiveScreenRedesign.tsx', 'utf8');
  const playback = readFileSync('src/screens/PlaybackScreen.tsx', 'utf8');
  assert(player.includes('nativeControls={false}'), 'o app não deve exibir o player genérico do Android');
  assert(player.includes('accessibilityLabel="Voltar 10 segundos"'), 'o player precisa retroceder rapidamente');
  assert(player.includes('accessibilityLabel="Avançar 10 segundos"'), 'o player precisa avançar rapidamente');
  assert(player.includes('recordingStartedAt'), 'o player deve mostrar o horário real da gravação');
  assert(live.includes('TIMELINE_WIDTH = 24 * TIMELINE_HOUR_WIDTH'), 'a régua dentro da câmera não pode comprimir 24 horas na tela');
  assert(live.includes('onOpenPlayback(nearest.recording, offset)'), 'tocar na régua deve abrir dentro do trecho, não apenas no início');
  assert(playback.includes('onOpenPlayback(target.recording, offset)'), 'a página geral de gravações também deve abrir no horário exato');
  assert(playback.includes('timelineRef.current?.scrollTo'), 'a régua deve navegar horizontalmente até o período útil');
});

test('release mobile: iOS tem identidade e builds de loja incrementam versão', () => {
  const base = JSON.parse(readFileSync('app.base.json', 'utf8')).expo;
  const eas = JSON.parse(readFileSync('eas.json', 'utf8'));
  assert(Boolean(base.ios?.bundleIdentifier), 'iOS precisa de bundleIdentifier para distribuição');
  assert(base.ios?.infoPlist?.ITSAppUsesNonExemptEncryption === false, 'declaração de criptografia da App Store deve ser explícita');
  assert(eas.build?.production?.distribution === 'store', 'release deve gerar artefato para loja');
  assert(eas.build?.production?.autoIncrement === true, 'release deve evitar colisão de buildNumber/versionCode');
});

test('white-label build: senha da keystore nunca em texto claro (invariante 1.2.ii)', () => {
  // build-client.sh roda no HOST (fora do container) com acesso às keystores de
  // assinatura. A senha de cada cliente vive num arquivo 0600 ao lado da keystore
  // e JAMAIS pode: virar argumento de linha de comando (visível no `ps` p/ outros
  // usuários), cair numa variável de shell, ou aparecer num echo. Este teste trava
  // a regressão que reintroduziria isso no fluxo de assinatura do APK e do AAB.
  const sh = readFileSync('scripts/build-client.sh', 'utf8');

  // Toda ferramenta de assinatura lê a senha do arquivo 0600, nunca de um argumento.
  assert(sh.includes('-storepass:file "$PASS_FILE" -keypass:file "$PASS_FILE"'),
    'keytool/jarsigner devem ler a senha via -storepass:file (não como argumento)');
  assert(sh.includes('--ks-pass "file:$PASS_FILE"'),
    'apksigner deve ler a senha via --ks-pass file: (não como argumento)');

  // Nenhum `-storepass <valor>` / `-keypass <valor>` em texto claro: no fluxo
  // seguro só existem as formas com dois-pontos (`-storepass:file`/`:env`), então
  // um espaço após a flag denuncia a senha exposta no process list.
  assert(!/-storepass /.test(sh), 'nenhum -storepass com senha em texto claro (use :file)');
  assert(!/-keypass /.test(sh), 'nenhum -keypass com senha em texto claro (use :file)');

  // A senha não pode ser slurpada para uma variável de shell (rastro em `set -x`,
  // core dump, ou reuso acidental como argumento).
  assert(!/KS_PASS=/.test(sh), 'a senha da keystore não pode cair numa variável de shell');
  assert(!/cat "\$PASS_FILE"/.test(sh), 'a senha não pode ser lida via cat do arquivo .pass');

  // Falha CEDO e clara se a senha não estiver disponível — nunca gera um artefato
  // sem assinatura nem assina com senha vazia.
  assert(/\[\[ ! -s "\$PASS_FILE" \]\]/.test(sh),
    'deve falhar cedo quando o arquivo de senha estiver ausente/vazio');
});

test('formatDateLabel: hoje e data histórica', () => {
  const today = localDateKey();
  assert(formatDateLabel(today) === 'Hoje', 'data atual deve ser Hoje');
  assert(formatDateLabel('2026-05-20').includes('20'), 'data histórica deve conter dia');
});

test('playback: filtra origem da gravação e calcula posição na linha do tempo', () => {
  const motion = { id: '1', cameraId: 'c1', startedAt: '2026-07-14T06:00:00', durationSeconds: 60, triggerMode: 'motion', fileUsable: true } as Recording;
  const unavailable = { ...motion, id: '2', triggerMode: 'continuous', fileUsable: false } as Recording;
  assert(recordingKind(motion) === 'motion', 'modo motion deve ser reconhecido');
  assert(matchesPlaybackFilter(motion, 'motion'), 'gravação de movimento deve passar no filtro');
  assert(!matchesPlaybackFilter(unavailable, 'continuous'), 'arquivo indisponível não deve aparecer como contínuo disponível');
  assert(matchesPlaybackFilter(unavailable, 'unavailable'), 'arquivo ausente deve aparecer em indisponíveis');
  const range = timelineRange(motion);
  assert(Math.abs(range.left - 25) < 0.01, `06:00 deve ficar em 25% do dia (got ${range.left})`);
  assert(range.width >= 0.45, 'trechos curtos devem continuar tocáveis e visíveis');
});

test('localDateKey: usa componentes locais sem converter para UTC', () => {
  const fakeLocalDate = {
    getFullYear: () => 2026,
    getMonth: () => 6,
    getDate: () => 9,
  } as Date;
  assert(localDateKey(fakeLocalDate) === '2026-07-09', 'data local deve preservar ano, mês e dia');
});

test('localDayIsoRange: envia início e fim do dia civil no fuso do aparelho', () => {
  const range = localDayIsoRange('2026-07-09');
  const from = new Date(range.from);
  const to = new Date(range.to);
  assert(localDateKey(from) === '2026-07-09', 'início deve permanecer no dia local solicitado');
  assert(localDateKey(to) === '2026-07-09', 'fim deve permanecer no dia local solicitado');
  assert(from.getHours() === 0 && from.getMinutes() === 0, 'início deve ser meia-noite local');
  assert(to.getHours() === 23 && to.getMinutes() === 59, 'fim deve ser 23:59 local');
});

test('branding: corrige combinações de texto sem contraste', () => {
  assert((contrastRatio('#ffffff', '#000000') ?? 0) > 20, 'preto e branco devem ter contraste máximo');
  assert(ensureReadableText('#ffffff', ['#ffffff']) === '#0b0d12', 'texto branco sobre fundo branco deve ser corrigido');
  assert(ensureReadableText('#ffffff', ['#000000']) === '#ffffff', 'combinação legível deve ser preservada');
});

test('branding: separa as paletas clara e escura recebidas do servidor', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    facilityName: 'Instalação',
    brandUseDefaultColors: true,
    brandPrimaryColor: '#111111',
    brandBackgroundColor: '#000000',
    brandLightPrimaryColor: '#222222',
    brandLightBackgroundColor: '#ffffff',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const branding = await fetchBranding('https://api.local');
    assert(branding.useDefaultColors, 'toggle de cores padrão deve ser mapeado');
    assert(branding.dark.primaryColor === '#111111', 'tema escuro deve usar chaves históricas');
    assert(branding.dark.backgroundColor === '#000000', 'fundo escuro deve ser mapeado');
    assert(branding.light.primaryColor === '#222222', 'tema claro deve usar chaves brandLight');
    assert(branding.light.backgroundColor === '#ffffff', 'fundo claro deve ser mapeado');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('branding offline: conserva por instalação apenas a última resposta válida', () => {
  const branding = readFileSync('src/services/branding.ts', 'utf8');
  const app = readFileSync('App.tsx', 'utf8');

  assert(branding.includes("BRANDING_CACHE_PREFIX = '@drac:runtime-branding:v1:'"), 'cache de marca deve ter namespace próprio');
  assert(branding.includes('export async function loadCachedBranding'), 'marca previamente recebida deve poder ser restaurada offline');
  assert(branding.includes('export async function saveCachedBranding'), 'uma resposta válida deve ser persistida');
  assert(app.includes('restoreCachedBranding(DEFAULT_API_URL)'), 'login deve restaurar a marca antes de depender da rede');
  assert(app.includes('saveCachedBranding(url, next)'), 'download bem-sucedido deve atualizar o cache');
});

test('login manual: inicia no Início e descarta resposta antiga de push', () => {
  const app = readFileSync('App.tsx', 'utf8');
  assert(app.includes('await Notifications.clearLastNotificationResponseAsync().catch(() => undefined);'), 'push pendente não pode redirecionar uma sessão nova');
  assert(app.includes("setTab('central');\n      activateSession(nextSession);"), 'login manual deve abrir a aba Início');
});

test('isOnline: normaliza status da câmera', () => {
  assert(isOnline({ status: 'ONLINE' } as Camera), 'ONLINE deve estar online');
  assert(isOnline({ status: 'online' } as Camera), 'online deve estar online');
  assert(!isOnline({ status: 'OFFLINE' } as Camera), 'OFFLINE deve estar offline');
});

test('normalizeServerUrl: troca localhost pelo host da API', () => {
  const normalized = normalizeServerUrl('http://localhost:3002/camera-stream/1/poster', 'http://168.194.13.70:3002');
  assert(normalized === 'http://168.194.13.70:3002/camera-stream/1/poster', 'localhost deve ser substituído');
  assert(normalizeServerUrl(null, 'http://api.local') === null, 'null deve retornar null');
  assert(normalizeServerUrl('javascript:alert(1)', 'https://api.local') === null, 'esquema não HTTP deve ser rejeitado');
  assert(normalizeServerUrl('https://user:senha@media.local/live', 'https://api.local') === null, 'URL de mídia não pode carregar credencial embutida');
  assert(normalizeServerUrl('http://localhost:8888/live', 'https://api.local') === 'https://api.local/live', 'URL interna deve herdar TLS e origem pública da API');
});

test('media URL: preserva query e adiciona streamToken curto', () => {
  const url = authenticatedMediaUrl('https://media.local/cam/whep?view=grid', 'https://api.local', 'token curto');
  assert(url != null, 'URL válida deve ser retornada');
  const parsed = new URL(url!);
  assert(parsed.searchParams.get('view') === 'grid', 'query existente deve ser preservada');
  assert(parsed.searchParams.get('token') === 'token curto', 'streamToken deve ser anexado');
  assert(isSecureMediaUrl(url), 'HTTPS deve ser reconhecido como seguro');
  assert(!isSecureMediaUrl('http://media.local/live.m3u8'), 'HTTP não deve ser tratado como seguro');
});

test('request: envia autorização e parseia JSON', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const data = await request<{ ok: boolean }>('http://api.local', '/ping', 'token-123');
  assert(data.ok === true, 'request deve retornar JSON');
  assert(calls[0]?.url === 'http://api.local/ping', 'request deve montar URL');
  assert((calls[0]?.init?.headers as Record<string, string>).Authorization === 'Bearer token-123', 'request deve enviar bearer token');
});

test('request: transforma AbortError em mensagem amigável', async () => {
  globalThis.fetch = (async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }) as typeof fetch;

  let message = '';
  try {
    await request('http://api.local', '/slow');
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  assert(message === 'Tempo esgotado. Verifique a conexão.', 'AbortError deve virar timeout amigável');
});

test('cache de stream: deduplica por sessão sem compartilhar credenciais', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  clearStreamUrlsCache();
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    return new Response(JSON.stringify({ authorization }), { status: 200 });
  }) as typeof fetch;
  try {
    const [first, duplicate] = await Promise.all([
      requestCachedStreamUrls<{ authorization: string }>('https://api.local', 'cam-1', 'token-a'),
      requestCachedStreamUrls<{ authorization: string }>('https://api.local', 'cam-1', 'token-a'),
    ]);
    const otherSession = await requestCachedStreamUrls<{ authorization: string }>('https://api.local', 'cam-1', 'token-b');
    assert(calls === 2, `mesma sessão deve deduplicar e outra sessão deve buscar novamente (got ${calls})`);
    assert(first.authorization === 'Bearer token-a' && duplicate.authorization === 'Bearer token-a', 'resposta deduplicada deve manter a sessão correta');
    assert(otherSession.authorization === 'Bearer token-b', 'cache não deve vazar token entre contas');
  } finally {
    clearStreamUrlsCache();
    globalThis.fetch = originalFetch;
  }
});

test('cache de stream: erro não JSON continua legível', async () => {
  const originalFetch = globalThis.fetch;
  clearStreamUrlsCache();
  globalThis.fetch = (async () => new Response('gateway indisponível', { status: 502 })) as typeof fetch;
  let message = '';
  try {
    await requestCachedStreamUrls('https://api.local', 'cam-2', 'token-a');
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  } finally {
    clearStreamUrlsCache();
    globalThis.fetch = originalFetch;
  }
  assert(message === 'gateway indisponível', 'erro textual do servidor deve ser preservado');
});

test('cache de stream: Economia solicita explicitamente a fonte leve da grade', async () => {
  const originalFetch = globalThis.fetch;
  let requested = '';
  clearStreamUrlsCache();
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested = String(url);
    return new Response(JSON.stringify({ protocols: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    await requestCachedStreamUrls('https://api.local', 'cam-eco', 'token-a', undefined, 'grid');
    assert(/viewMode=grid/.test(requested), `Economia deve solicitar viewMode=grid (got ${requested})`);
  } finally {
    clearStreamUrlsCache();
    globalThis.fetch = originalFetch;
  }
});

test('computeDetectionRect: mapeia bbox respeitando o letterbox do contain', () => {
  // Frame 1000x1000 num container 200x100 → vídeo renderizado fica 100x100,
  // centralizado, com 50px de letterbox em cada lado horizontal.
  const rect = computeDetectionRect([0, 0, 500, 500], 1000, 1000, 200, 100);
  assert(Math.abs(rect.left - 50) < 0.001, `left deve considerar offset do letterbox (got ${rect.left})`);
  assert(Math.abs(rect.top - 0) < 0.001, `top deve ser 0 (got ${rect.top})`);
  assert(Math.abs(rect.width - 50) < 0.001, `width deve escalar pela menor dimensão (got ${rect.width})`);
  assert(Math.abs(rect.height - 50) < 0.001, `height deve escalar pela menor dimensão (got ${rect.height})`);

  // Caixa degenerada não deve sumir: largura/altura mínima de 2px.
  const tiny = computeDetectionRect([10, 10, 10, 10], 1000, 1000, 100, 100);
  assert(tiny.width >= 2 && tiny.height >= 2, 'caixa mínima deve ter ao menos 2px');
});

test('api 401: requisição AUTENTICADA dispara o handler de sessão expirada', async () => {
  const originalFetch = globalThis.fetch;
  let fired = 0;
  let receivedToken = '';
  setUnauthorizedHandler((token) => { fired += 1; receivedToken = token ?? ''; });
  globalThis.fetch = (async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ message: 'expired' }),
  })) as unknown as typeof fetch;
  try {
    await request('http://x', '/cameras', 'a-token').catch(() => undefined);
    assert(fired === 1, `handler deveria disparar 1x em 401 autenticado (got ${fired})`);
    assert(receivedToken === 'a-token', 'handler deve identificar qual sessão originou o 401');
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
  }
});

test('api 401: SEM token (login) NÃO dispara o handler', async () => {
  const originalFetch = globalThis.fetch;
  let fired = 0;
  setUnauthorizedHandler(() => { fired += 1; });
  globalThis.fetch = (async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ message: 'senha inválida' }),
  })) as unknown as typeof fetch;
  try {
    await request('http://x', '/auth/login').catch(() => undefined);
    assert(fired === 0, `handler NÃO deve disparar em 401 sem token (got ${fired})`);
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
  }
});

test('api 401: renova o token e repete a requisição sem desconectar', async () => {
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  let unauthorized = 0;
  setUnauthorizedHandler(() => { unauthorized += 1; });
  setTokenRefreshHandler(async (expired) => expired === 'token-antigo' ? 'token-novo' : null);
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    authorizations.push(authorization);
    if (authorization === 'Bearer token-antigo') {
      return new Response(JSON.stringify({ message: 'expired' }), { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await request<{ ok: boolean }>('http://x', '/cameras', 'token-antigo');
    assert(result.ok === true, 'requisição repetida deve ter sucesso');
    assert(authorizations.join(',') === 'Bearer token-antigo,Bearer token-novo', 'deve repetir com o token renovado');
    assert(unauthorized === 0, 'renovação bem-sucedida não deve desconectar');
  } finally {
    globalThis.fetch = originalFetch;
    setTokenRefreshHandler(null);
    setUnauthorizedHandler(null);
  }
});
