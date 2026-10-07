// build-agent.mjs — agente de build white-label, roda NO HOST (onde estão o
// toolchain Android e o build-client.sh). A API (em container) NÃO consegue
// buildar; ela faz proxy autenticado para este agente.
//
// Endpoints (header x-build-token obrigatório, exceto /health):
//   GET  /health
//   GET  /clients                 → lista clientes + status do último build
//   POST /clients {slug,appName,apiUrl,packageId?,primaryColor?,logoBase64?,appIconBase64?,resetAppIcon?,firebaseConfigBase64?}
//   DELETE /clients/:slug         → apaga config + APK (local e nginx) + jobs
//   POST /builds  {slug}          → enfileira build (serializado) → {jobId}
//   GET  /builds                  → histórico (sem log completo)
//   GET  /builds/:id              → job com log
//
// Variáveis: BUILD_AGENT_HOST (127.0.0.1), BUILD_AGENT_PORT (8780),
//   BUILD_AGENT_TOKEN (obrigatório), PUBLIC_APK_BASE_OVERRIDE (preferencial),
//   PUBLIC_APK_BASE (https://s2cam.com.br), MIN_FREE_GB (6).
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureApprovedCommit, acquireBuildLease } from './build-maintenance.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = path.resolve(__dirname, '..');
const CLIENTS_DIR = path.join(MOBILE_DIR, 'clients');
const BUILDS_DIR = path.join(MOBILE_DIR, 'builds');
const STATE_FILE = path.join(BUILDS_DIR, 'agent-state.json');
// Diretório do host servido pelo nginx em /apk (sobrevive a rebuilds do vms-web).
const APK_PUBLISH_DIR = process.env.APK_PUBLISH_DIR || path.resolve(MOBILE_DIR, '../../infra/apk');

const PORT = Number(process.env.BUILD_AGENT_PORT || 8780);
const HOST = process.env.BUILD_AGENT_HOST || '127.0.0.1';
const TOKEN = process.env.BUILD_AGENT_TOKEN || '';
const PUBLIC_APK_BASE = (
  process.env.PUBLIC_APK_BASE_OVERRIDE
  || process.env.PUBLIC_APK_BASE
  || 'https://s2cam.com.br'
).replace(/\/+$/, '');
const MIN_FREE_GB = process.env.MIN_FREE_GB || '6';

// O agente pode estar atualizado antes da versão que a Central aprovou para a
// frota. Antes ele simplesmente recusava o build nesse caso, deixando a tela
// de Apps sem uma saída útil. Cada build agora usa um worktree descartável do
// commit APROVADO: a Central continua sendo a única autoridade da release e o
// agente não precisa fazer checkout (nem parar) o seu próprio código.
const REPO_ROOT = (() => {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: MOBILE_DIR, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
})();
const BUILD_WORKTREES_DIR = process.env.BUILD_AGENT_WORKTREES_DIR
  || path.join(os.homedir(), '.cache', 's2cam-build-agent', 'worktrees');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
// apiUrl e appName ficavam SEM validação enquanto slug/packageId eram estritos. Os dois
// descem para o build-client.sh, que roda no HOST com as keystores — e o apiUrl chegava a
// ser interpolado no fonte de um `node -e`. Validar aqui é a 2ª barreira (a 1ª é passar
// tudo por env/argv em vez de costurar em código).
const API_URL_RE = /^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
const OPTIONAL_URL_RE = /^(?:https?:\/\/[A-Za-z0-9._-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/?=&%+-]*)?)?$/;
// Nome de exibição: letras/números/espaço e pontuação simples. Sem aspas, sem barra
// (vira nome de arquivo no kit: `${APP_NAME}.aab`), sem '..'.
const APP_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,59}$/u;
const IMAGE_DATA_URL_MAX_CHARS = 550_000;
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;

fs.mkdirSync(BUILDS_DIR, { recursive: true });

let state = { jobs: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* primeiro start */ }
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// ── Fila serializada (1 build por vez) ─────────────────────────────────────
let running = false;
const queue = [];

function git(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} falhou`).trim());
  }
  return result.stdout.trim();
}

function ensureBuildWorktree(commit, slug) {
  if (!REPO_ROOT) throw new Error('repositório do aplicativo não foi encontrado no build-agent');
  if (!/^[0-9a-f]{40}$/i.test(String(commit || ''))) throw new Error('commit de release inválido');
  if (!SLUG_RE.test(String(slug || ''))) throw new Error('cliente inválido para build');

  // A Central pode aprovar uma release segundos depois de o agente iniciar.
  // Nesse caso o clone local ainda não conhece o commit. Busque o remoto sob
  // demanda e confira novamente; sem isso toda primeira geração da release
  // falha instantaneamente com "Not a valid object name".
  ensureApprovedCommit(REPO_ROOT, commit, process.env.BUILD_AGENT_VENDOR_SOURCE || '');
  fs.mkdirSync(BUILD_WORKTREES_DIR, { recursive: true, mode: 0o700 });
  const worktree = path.join(BUILD_WORKTREES_DIR, String(commit).toLowerCase());
  const mobile = path.join(worktree, 'apps', 'mobile');
  if (!fs.existsSync(path.join(worktree, '.git'))) {
    git(['worktree', 'add', '--detach', worktree, commit], { cwd: REPO_ROOT });
  }
  const head = git(['rev-parse', 'HEAD'], { cwd: worktree });
  if (head.toLowerCase() !== String(commit).toLowerCase()) {
    throw new Error('worktree de build não corresponde à release aprovada');
  }

  // Dependências não entram no Git. O link evita uma instalação de pacotes a
  // cada APK e mantém o build isolado do código ativo do agente.
  const moduleTrees = [
    [path.join(REPO_ROOT, 'node_modules'), path.join(worktree, 'node_modules')],
    [path.join(MOBILE_DIR, 'node_modules'), path.join(mobile, 'node_modules')],
  ];
  for (const [sourceModules, worktreeModules] of moduleTrees) {
    // O pnpm cria links RELATIVOS dentro de node_modules. Um único symlink
    // externo parece válido ao Node, mas o Metro o rejeita ao montar o bundle.
    // `cp -al` replica a árvore como hardlinks: mesma ocupação real em disco e
    // caminhos locais íntegros para Gradle/Metro.
    const isSymlink = (() => { try { return fs.lstatSync(worktreeModules).isSymbolicLink(); } catch { return false; } })();
    if ((isSymlink || !fs.existsSync(worktreeModules)) && fs.existsSync(sourceModules)) {
      fs.rmSync(worktreeModules, { recursive: true, force: true });
      const copied = spawnSync('cp', ['-al', sourceModules, worktreeModules], { encoding: 'utf8' });
      if (copied.status !== 0) throw new Error(`não foi possível preparar dependências: ${(copied.stderr || '').trim()}`);
    }
  }

  // A release pode acrescentar/remover dependências sem que o checkout ativo
  // do agente tenha sido reinstalado. Copiar node_modules antigos nesse caso
  // produz um APK que falha no Metro com "Unable to resolve module". O install
  // incremental roda DENTRO do worktree aprovado, usa seu lockfile exato e
  // normalmente só relinka o que já existe no store local do pnpm.
  const dependencies = spawnSync('corepack', [
    'pnpm', '--filter', 'mobile...', 'install', '--frozen-lockfile', '--prefer-offline',
  ], {
    cwd: worktree,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  if (dependencies.status !== 0) {
    throw new Error(`não foi possível sincronizar as dependências da release: ${(dependencies.stderr || dependencies.stdout || '').trim()}`);
  }

  // CMake grava fingerprints binários dentro de node_modules/**/android/.cxx.
  // Como os worktrees reutilizam dependências por hardlink, esse cache pode ter
  // sido produzido por outra geração e o Gradle falha com CXX1420. É conteúdo
  // temporário: limpá-lo preserva as dependências e isola cada build.
  // pnpm pode resolver o módulo tanto pelo node_modules da raiz do monorepo
  // quanto pelo node_modules do app. Limpe ambos: limpar apenas o segundo não
  // alcança expo-modules-core quando ele foi hoisted para a raiz.
  for (const nodeModules of [path.join(worktree, 'node_modules'), path.join(mobile, 'node_modules')]) {
    if (!fs.existsSync(nodeModules)) continue;
    const cleanup = spawnSync('find', [
      nodeModules,
      '-type', 'd',
      '-name', '.cxx',
      '-prune',
      '-exec', 'rm', '-rf', '--', '{}', '+',
    ], { encoding: 'utf8' });
    if (cleanup.status !== 0) {
      throw new Error(`não foi possível limpar o cache nativo do Android: ${(cleanup.stderr || '').trim()}`);
    }
  }

  // Branding/configuração do cliente é estado do agente, não parte da release.
  // Copiamos somente o cliente solicitado para que uma geração não altere o
  // checkout aprovado nem vaze identidade entre clientes.
  const sourceClient = path.join(CLIENTS_DIR, slug);
  const targetClient = path.join(mobile, 'clients', slug);
  if (!fs.existsSync(sourceClient)) throw new Error('configuração do cliente não existe no build-agent');
  fs.rmSync(targetClient, { recursive: true, force: true });
  fs.cpSync(sourceClient, targetClient, { recursive: true, force: true });
  return mobile;
}

function summarizeBuildFailure(log, code) {
  const text = String(log || '');
  if (/CXX1420|structured log file|configure_fingerprint\.bin/i.test(text)) {
    return 'Um arquivo temporário do Android ficou inconsistente. O sistema já fez a limpeza; tente gerar novamente.';
  }
  if (/no space left|enospc|espa[cç]o insuficiente|disk full/i.test(text)) {
    return 'O servidor está sem espaço suficiente para preparar o aplicativo.';
  }
  if (/keystore|signing|private key|certificate|assinatura/i.test(text)) {
    return 'Não foi possível assinar o aplicativo. Confira a configuração de publicação.';
  }
  if (/firebase|google-services\.json|messaging/i.test(text)) {
    return 'Não foi possível preparar as notificações do aplicativo. Confira a configuração do Firebase.';
  }
  if (/unable to resolve module|module not found|cannot find module|could not resolve .+ from/i.test(text)) {
    return 'Um componente necessário do aplicativo não foi instalado corretamente. Gere novamente; se persistir, consulte o suporte.';
  }
  if (/logo do cliente|adaptive.?icon|(?:process|decode|convert|read).{0,40}(?:imagem|image|png|jpe?g)|sharp.{0,80}(?:error|fail)|invalid.{0,30}(?:png|jpe?g|image)/i.test(text)) {
    return 'Uma imagem da personalização não pôde ser processada. Escolha outra imagem e tente novamente.';
  }
  if (/network|timed? ?out|econn|could not (get|resolve|download)|unable to resolve|npm registry/i.test(text)) {
    return 'O servidor não conseguiu baixar um componente necessário. Tente novamente em alguns minutos.';
  }
  if (/configuração do cliente não existe/i.test(text)) {
    return 'A personalização deste cliente não foi encontrada. Salve os dados do aplicativo e tente novamente.';
  }
  void code;
  return 'O aplicativo anterior continua disponível. Tente gerar novamente; se o problema continuar, consulte o suporte.';
}

async function processQueue() {
  if (running || queue.length === 0) return;
  const job = queue.shift();
  running = true;
  let buildMobileDir;
  let releaseLease;
  try {
    releaseLease = await acquireBuildLease(BUILD_WORKTREES_DIR);
    job.status = 'building';
    job.startedAt = new Date().toISOString();
    saveState();
    buildMobileDir = ensureBuildWorktree(job.sourceCommit, job.slug);
  } catch (error) {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.log = error instanceof Error ? error.message : 'não foi possível preparar a release aprovada';
    job.error = /permiss|permission|cannot lock ref/i.test(job.log)
      ? 'Não foi possível acessar os arquivos necessários para preparar o aplicativo. Consulte o suporte.'
      : /valid object|bad object|versão aprovada|release aprovada/i.test(job.log)
        ? 'A versão aprovada ainda não está disponível para preparar o aplicativo. Consulte o suporte.'
        : summarizeBuildFailure(job.log);
    saveState();
    if (releaseLease) await releaseLease();
    running = false;
    processQueue();
    return;
  }
  const child = spawn('bash', [path.join(buildMobileDir, 'scripts', 'build-client.sh'), job.slug], {
    cwd: buildMobileDir,
    env: {
      ...process.env,
      MIN_FREE_GB,
      EXPECTED_SOURCE_COMMIT: job.sourceCommit || '',
      // Contador de versão e artefatos intermediários sobrevivem ao worktree.
      BUILD_STATE_DIR: BUILDS_DIR,
    },
  });
  let log = '';
  const append = (b) => { log = (log + b.toString()).slice(-8000); job.log = log; };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let finished = false;
  const finish = async (code) => {
    if (finished) return;
    finished = true;
    job.finishedAt = new Date().toISOString();
    if (code === 0) {
      job.status = 'done';
      const ver = /OK_VERSION=(.+)/.exec(log);
      const url = /OK_URL=(.+)/.exec(log);
      const aab = /OK_AAB_URL=(.+)/.exec(log);
      job.version = ver ? ver[1].trim() : null;
      job.url = url ? PUBLIC_APK_BASE + url[1].trim() : null;
      job.aabUrl = aab ? PUBLIC_APK_BASE + aab[1].trim() : null;
    } else {
      job.status = 'failed';
      job.error = summarizeBuildFailure(log, code);
    }
    saveState();
    await releaseLease();
    running = false;
    processQueue();
  };
  child.on('error', error => { append(error.message); void finish(1); });
  child.on('close', code => { void finish(code); });
}

// ── Helpers de clientes ────────────────────────────────────────────────────
function listClients() {
  let slugs = [];
  try { slugs = fs.readdirSync(CLIENTS_DIR).filter((s) => s !== 'default'); } catch { /* vazio */ }
  return slugs.map((slug) => {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, slug, 'config.json'), 'utf8')); } catch { /* */ }
    const apk = path.join(APK_PUBLISH_DIR, `drac-${slug}.apk`);
    const aab = path.join(APK_PUBLISH_DIR, `drac-${slug}.aab`);
    const kit = path.join(APK_PUBLISH_DIR, `drac-${slug}-playstore-kit.zip`);
    const lastJob = [...state.jobs].reverse().find((j) => j.slug === slug);
    return {
      slug,
      appName: cfg.appName ?? slug,
      apiUrl: cfg.apiUrl ?? '',
      packageId: cfg.packageId ?? '',
      apkBaseUrl: cfg.apkBaseUrl ?? '',
      pushEnabled: cfg.pushEnabled === true,
      crashReportingEnabled: Boolean(cfg.crashDsn),
      primaryColor: cfg.primaryColor ?? null,
      hasLogo: fs.existsSync(path.join(CLIENTS_DIR, slug, 'logo.png')),
      apkExists: fs.existsSync(apk),
      apkUrl: fs.existsSync(apk) ? `${PUBLIC_APK_BASE}/apk/drac-${slug}.apk` : null,
      aabExists: fs.existsSync(aab),
      aabUrl: fs.existsSync(aab) ? `${PUBLIC_APK_BASE}/apk/drac-${slug}.aab` : null,
      kitExists: fs.existsSync(kit),
      kitUrl: fs.existsSync(kit) ? `${PUBLIC_APK_BASE}/apk/drac-${slug}-playstore-kit.zip` : null,
      lastBuild: lastJob ? {
        id: lastJob.id,
        status: lastJob.status,
        version: lastJob.version ?? null,
        finishedAt: lastJob.finishedAt ?? null,
        error: lastJob.status === 'failed' ? (lastJob.error || summarizeBuildFailure(lastJob.log, null)) : null,
      } : null,
    };
  });
}

// Roda ffmpeg lendo o arquivo pelo CONTEÚDO (não pela extensão) — o logo pode
// chegar em qualquer formato (JPEG/WebP/etc) do endpoint /settings/branding.
function ffmpegConvert(args) {
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return { ok: r.status === 0, stderr: r.stderr ? r.stderr.toString() : '' };
}

// Converte o logo do cliente em logo.png (tela de login) + splash.png (abertura
// limpa, sem cards) + icon.png/adaptive-icon.png (ícone do launcher Android — app.config.js já
// sabe usar esses arquivos se existirem, mas antes disso nada os gerava, então
// o app instalado ficava com o ícone genérico mesmo com o logo aplicado na
// tela de login).
//
// IMPORTANTE: gera tudo num diretório TEMPORÁRIO (staging) e devolve o caminho.
// Quem chama só move para o diretório do cliente depois que TUDO deu certo —
// assim um logo inválido NUNCA deixa um cliente pela metade no disco. Lança
// erro (em vez de cair silenciosamente pro padrão) se o arquivo enviado não
// for uma imagem decodificável — a Central mostra o problema na hora de gerar
// o app, não só depois de instalar o APK.
function stageClientBranding(logoBase64) {
  const data = String(logoBase64).replace(/^data:image\/[\w.+-]+;base64,/, '');
  const raw = Buffer.from(data, 'base64');
  if (raw.length < 16) throw new Error('logo do cliente vazio ou inválido');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'drac-brand-'));
  const srcPath = path.join(stage, 'src');
  fs.writeFileSync(srcPath, raw);
  try {
    const logo = ffmpegConvert(['-y', '-loglevel', 'error', '-i', srcPath, '-pix_fmt', 'rgba', path.join(stage, 'logo.png')]);
    if (!logo.ok) throw new Error(`logo do cliente não pôde ser decodificado (formato inválido): ${logo.stderr.trim().slice(0, 300)}`);
    const icon = ffmpegConvert(['-y', '-loglevel', 'error', '-i', srcPath,
      '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease,pad=1024:1024:(ow-iw)/2:(oh-ih)/2:color=0x071013',
      '-pix_fmt', 'rgba', path.join(stage, 'icon.png')]);
    if (!icon.ok) throw new Error(`falha ao gerar ícone do app a partir do logo: ${icon.stderr.trim().slice(0, 300)}`);
    // Ícone adaptativo Android: o sistema recorta ~33% das bordas, então o
    // conteúdo precisa ficar menor e centralizado (fundo transparente).
    const adaptive = ffmpegConvert(['-y', '-loglevel', 'error', '-i', srcPath,
      '-vf', 'scale=620:620:force_original_aspect_ratio=decrease,pad=1024:1024:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
      '-pix_fmt', 'rgba', path.join(stage, 'adaptive-icon.png')]);
    if (!adaptive.ok) throw new Error(`falha ao gerar ícone adaptativo do app: ${adaptive.stderr.trim().slice(0, 300)}`);
    const splash = ffmpegConvert(['-y', '-loglevel', 'error', '-i', srcPath,
      '-vf', 'scale=560:560:force_original_aspect_ratio=decrease,pad=1024:1024:(ow-iw)/2:(oh-ih)/2:color=white',
      '-pix_fmt', 'rgba', path.join(stage, 'splash.png')]);
    if (!splash.ok) throw new Error(`falha ao gerar tela de abertura do app: ${splash.stderr.trim().slice(0, 300)}`);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  fs.rmSync(srcPath, { force: true });
  return stage; // contém logo.png, icon.png, adaptive-icon.png
}

// O ícone do launcher pode ser escolhido na Central sem alterar a logo da
// instalação. Gera somente os dois assets consumidos pelo Android; logo e
// splash continuam pertencendo à identidade visual do cliente.
function stageClientAppIcon(iconBase64) {
  const data = String(iconBase64).replace(/^data:image\/[\w.+-]+;base64,/, '');
  const raw = Buffer.from(data, 'base64');
  if (raw.length < 16) throw new Error('ícone do aplicativo vazio ou inválido');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 's2cam-app-icon-'));
  const srcPath = path.join(stage, 'src');
  fs.writeFileSync(srcPath, raw);
  try {
    const icon = ffmpegConvert(['-y', '-loglevel', 'error', '-i', srcPath,
      '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease,pad=1024:1024:(ow-iw)/2:(oh-ih)/2:color=0x071013',
      '-pix_fmt', 'rgba', path.join(stage, 'icon.png')]);
    if (!icon.ok) throw new Error(`ícone do aplicativo não pôde ser decodificado: ${icon.stderr.trim().slice(0, 300)}`);
    const adaptive = ffmpegConvert(['-y', '-loglevel', 'error', '-i', srcPath,
      '-vf', 'scale=720:720:force_original_aspect_ratio=decrease,pad=1024:1024:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
      '-pix_fmt', 'rgba', path.join(stage, 'adaptive-icon.png')]);
    if (!adaptive.ok) throw new Error(`falha ao gerar ícone adaptativo do aplicativo: ${adaptive.stderr.trim().slice(0, 300)}`);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  fs.rmSync(srcPath, { force: true });
  return stage;
}

function writeClient(body) {
  const { slug, appName, apiUrl } = body;
  if (!SLUG_RE.test(slug || '')) throw new Error('slug inválido (a-z 0-9 -)');
  if (!appName || !apiUrl) throw new Error('appName e apiUrl são obrigatórios');
  if (!APP_NAME_RE.test(String(appName))) throw new Error('appName inválido (letras, números, espaço e . _ - ( ), até 60)');
  if (!API_URL_RE.test(String(apiUrl))) throw new Error('apiUrl inválida (use http(s)://host[:porta][/caminho])');
  // Identidade padrão de novos white-labels. Pacotes já gravados no cliente
  // continuam explícitos e, portanto, não trocam de identidade por acidente.
  const packageId = body.packageId || `com.s2cam.${String(slug).replace(/-/g, '')}`;
  if (!PKG_RE.test(packageId)) throw new Error('packageId inválido');
  let firebaseConfig = null;
  if (body.firebaseConfigBase64 !== undefined) {
    if (typeof body.firebaseConfigBase64 !== 'string' || body.firebaseConfigBase64.length > 1024 * 1024) throw new Error('configuração Firebase inválida');
    try { firebaseConfig = JSON.parse(Buffer.from(body.firebaseConfigBase64, 'base64').toString('utf8')); } catch { throw new Error('configuração Firebase inválida'); }
    const matches = (firebaseConfig.client || []).some((client) => client?.client_info?.android_client_info?.package_name === packageId);
    if (!matches) throw new Error('configuração Firebase não corresponde ao pacote Android');
  }
  if (body.pushEnabled === true && !firebaseConfig) throw new Error('push exige configuração Firebase válida');
  if (body.appIconBase64 !== undefined && (
    typeof body.appIconBase64 !== 'string'
    || body.appIconBase64.length > IMAGE_DATA_URL_MAX_CHARS
    || !IMAGE_DATA_URL_RE.test(body.appIconBase64)
  )) throw new Error('ícone do aplicativo inválido');
  if (body.resetAppIcon !== undefined && typeof body.resetAppIcon !== 'boolean') throw new Error('resetAppIcon inválido');
  // Converte o branding ANTES de tocar no diretório do cliente: se o logo for
  // inválido, aborta aqui sem criar/alterar nada (evita cliente meia-boca).
  let brandingStage = null;
  let appIconStage = null;
  try {
    brandingStage = body.logoBase64 ? stageClientBranding(body.logoBase64) : null;
    appIconStage = body.appIconBase64 ? stageClientAppIcon(body.appIconBase64) : null;
  } catch (error) {
    if (brandingStage) fs.rmSync(brandingStage, { recursive: true, force: true });
    if (appIconStage) fs.rmSync(appIconStage, { recursive: true, force: true });
    throw error;
  }
  try {
    const dir = path.join(CLIENTS_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    // PRESERVA o config existente (flags manuais como redesign/skipFirebase não
    // podem sumir numa regeração pela Central) e só sobrepõe o que veio no body.
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); } catch { /* novo cliente */ }
    const cfg = {
      ...existing,
      appName, slug: `drac-${slug}`, packageId, apiUrl,
      apkBaseUrl: String(body.apkBaseUrl || existing.apkBaseUrl || `${PUBLIC_APK_BASE}/apk`).replace(/\/+$/, ''),
      crashDsn: body.crashDsn === undefined ? (existing.crashDsn || '') : String(body.crashDsn || ''),
      // Sem arquivo Firebase por pacote, declarar false conscientemente. Se a
      // Central pedir true, app.config.js bloqueia o build sem credencial.
      pushEnabled: body.pushEnabled === undefined ? (existing.pushEnabled === true) : body.pushEnabled === true,
      primaryColor: body.primaryColor || existing.primaryColor || '#3b82f6',
      // O design NOVO (redesign) é o padrão de todo app gerado — o antigo só
      // permanece se o config do cliente disser explicitamente redesign:false.
      redesign: existing.redesign !== undefined ? existing.redesign : true,
    };
    if (!OPTIONAL_URL_RE.test(cfg.apkBaseUrl) || !OPTIONAL_URL_RE.test(cfg.crashDsn)) {
      throw new Error('apkBaseUrl/crashDsn inválida');
    }
    // Splash combina com o design: escuro no redesign, claro no antigo (a menos
    // que o cliente já tenha um valor próprio salvo).
    cfg.splashBackgroundColor = existing.splashBackgroundColor
      || (cfg.redesign ? '#0A0D13' : '#ffffff');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
    // Arquivo público de configuração, mas específico do pacote. Ele não entra
    // no Git: vem da Firebase no instante do build. Ao desligar push, remove a
    // cópia anterior para que não haja reativação acidental num rebuild futuro.
    const firebasePath = path.join(dir, 'google-services.json');
    if (firebaseConfig) fs.writeFileSync(firebasePath, JSON.stringify(firebaseConfig, null, 2) + '\n', { mode: 0o600 });
    else fs.rmSync(firebasePath, { force: true });
    if (brandingStage) {
      for (const name of ['logo.png', 'splash.png', 'icon.png', 'adaptive-icon.png']) {
        fs.copyFileSync(path.join(brandingStage, name), path.join(dir, name));
      }
    }
    // A escolha da Central tem prioridade sobre o ícone derivado da logo.
    if (appIconStage) {
      for (const name of ['icon.png', 'adaptive-icon.png']) {
        fs.copyFileSync(path.join(appIconStage, name), path.join(dir, name));
      }
    } else if (body.resetAppIcon === true && !brandingStage) {
      // Sem ícone próprio e sem logo: volta ao ícone padrão em app.config.js,
      // removendo um arquivo que poderia ter sobrado de um build antigo.
      for (const name of ['icon.png', 'adaptive-icon.png']) fs.rmSync(path.join(dir, name), { force: true });
    }
    return cfg;
  } finally {
    if (brandingStage) fs.rmSync(brandingStage, { recursive: true, force: true });
    if (appIconStage) fs.rmSync(appIconStage, { recursive: true, force: true });
  }
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

// Apaga um app: config do cliente, APK local e o publicado no nginx, e os jobs.
// Mantém o keystore (~/toolchain/keystores/<slug>.jks) de propósito: se o mesmo
// cliente for regerado depois, o app instala por cima do antigo (mesma assinatura).
function deleteClient(slug) {
  if (!SLUG_RE.test(slug)) throw new Error('slug inválido');
  const dir = path.join(CLIENTS_DIR, slug);
  if (slug === 'default' || !fs.existsSync(dir)) throw new Error('cliente não existe');
  rmrf(dir);
  rmrf(path.join(BUILDS_DIR, `drac-${slug}.apk`));
  rmrf(path.join(BUILDS_DIR, `drac-${slug}.apk.idsig`));
  rmrf(path.join(APK_PUBLISH_DIR, `drac-${slug}.apk`)); // remove do diretório servido
  // Também remove o AAB e o kit (o delete antigo só limpava o APK → sobrava
  // AAB/kit órfãos servíveis). NÃO remove a keystore (updates precisam dela)
  // nem o contador `<slug>.versionCode` (a Play exige versionCode monotônico
  // mesmo após apagar+regerar).
  rmrf(path.join(BUILDS_DIR, `drac-${slug}.aab`));
  rmrf(path.join(APK_PUBLISH_DIR, `drac-${slug}.aab`));
  rmrf(path.join(BUILDS_DIR, `drac-${slug}-playstore-kit.zip`));
  rmrf(path.join(APK_PUBLISH_DIR, `drac-${slug}-playstore-kit.zip`));
  state.jobs = state.jobs.filter((j) => j.slug !== slug);
  saveState();
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve) => {
  let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve(null); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/health') return send(res, 200, { ok: true, busy: running, queued: queue.length });
  if (!TOKEN || req.headers['x-build-token'] !== TOKEN) return send(res, 401, { error: 'unauthorized' });

  try {
    // Read-only readiness check: never prepares a worktree, invokes Gradle,
    // changes the version counter or queues an APK.
    if (req.method === 'GET' && p === '/preflight') {
      const commit = url.searchParams.get('sourceCommit') || '';
      if (!/^[0-9a-f]{40}$/i.test(commit)) return send(res, 400, { error: 'versão aprovada inválida' });
      let sourceAvailable = false;
      try { git(['cat-file', '-e', `${commit}^{commit}`], { cwd: REPO_ROOT }); sourceAvailable = true; } catch { /* unavailable */ }
      const disks = [BUILD_WORKTREES_DIR, os.homedir()].map(dir => {
        const disk = fs.statfsSync(dir);
        return { area: dir === BUILD_WORKTREES_DIR ? 'compilation' : 'toolchain', freeGB: Number((disk.bavail * disk.bsize / 1024 ** 3).toFixed(2)) };
      });
      let writable = true;
      try { for (const dir of [BUILDS_DIR, BUILD_WORKTREES_DIR, path.join(REPO_ROOT, '.git')]) fs.accessSync(dir, fs.constants.W_OK); }
      catch { writable = false; }
      const minimumFreeGB = Number(MIN_FREE_GB);
      return send(res, 200, { ok: sourceAvailable && writable && disks.every(d => d.freeGB >= minimumFreeGB),
        sourceCommit: commit, sourceAvailable, writable, minimumFreeGB, disks, busy: running, queued: queue.length });
    }
    if (req.method === 'GET' && p === '/clients') return send(res, 200, { clients: listClients() });
    if (req.method === 'POST' && p === '/clients') {
      const body = await readBody(req);
      if (!body) return send(res, 400, { error: 'json inválido' });
      const cfg = writeClient(body);
      return send(res, 200, { ok: true, client: cfg });
    }
    if (req.method === 'POST' && p === '/builds') {
      const body = await readBody(req);
      if (!body || !SLUG_RE.test(body.slug || '')) return send(res, 400, { error: 'slug inválido' });
      if (!/^[0-9a-f]{40}$/i.test(String(body.sourceCommit || ''))) {
        return send(res, 409, { error: 'release não aprovada: sourceCommit completo é obrigatório' });
      }
      // A comparação com o HEAD do agente bloqueava exatamente o caso normal:
      // a Central pode estar liberando uma release anterior enquanto o agente
      // já recebeu manutenção. `ensureBuildWorktree` confere o commit pedido e
      // executa o build naquele checkout isolado, pouco antes da compilação.
      if (!fs.existsSync(path.join(CLIENTS_DIR, body.slug, 'config.json'))) return send(res, 404, { error: 'cliente não existe' });
      const job = { id: `${Date.now()}-${body.slug}`, slug: body.slug, sourceCommit: String(body.sourceCommit).toLowerCase(), status: 'queued', queuedAt: new Date().toISOString(), log: '' };
      state.jobs.push(job);
      if (state.jobs.length > 100) state.jobs = state.jobs.slice(-100);
      saveState();
      queue.push(job);
      processQueue();
      return send(res, 202, { jobId: job.id, status: job.status });
    }
    if (req.method === 'DELETE' && p.startsWith('/clients/')) {
      const slug = decodeURIComponent(p.slice('/clients/'.length));
      deleteClient(slug);
      return send(res, 200, { ok: true, slug });
    }
    if (req.method === 'GET' && p === '/builds') {
      const jobs = [...state.jobs].reverse().map(({ log, ...j }) => j);
      return send(res, 200, { jobs });
    }
    if (req.method === 'GET' && p.startsWith('/builds/')) {
      const id = decodeURIComponent(p.slice('/builds/'.length));
      const job = state.jobs.find((j) => j.id === id);
      return job ? send(res, 200, { job }) : send(res, 404, { error: 'job não encontrado' });
    }
    return send(res, 404, { error: 'rota não encontrada' });
  } catch (e) {
    return send(res, 400, { error: e instanceof Error ? e.message : 'erro' });
  }
});

server.listen(PORT, HOST, () => console.log(`build-agent ouvindo em ${HOST}:${PORT}`));
