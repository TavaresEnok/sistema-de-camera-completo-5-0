const http = require('node:http');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveConfig, createDatastore } = require('./datastore');
const {
  TECHNICAL_DOCUMENTATION,
  TECHNICAL_DOCUMENTATION_PERMISSION,
} = require('./technical-documentation');
const { normalizeComputeNodes, validateComputeNodes, summarizeNodes } = require('./datastore/compute-nodes');
const { normalizeAiPolicy, validateAiPolicy, applyAiPolicyToRestrictions, describeAiPolicy } = require('./ai-policy');
const { normalizarTeto, tetoParaHeartbeat } = require('./teto-de-cameras');
const { normalizePlan, limitsFor, usageFor } = require('./license-resources');
const { decidirMatricula } = require('./matricula');
const { decidirRemocao } = require('./remocao-de-instalacao');
const { validarPerfilDeVpn, perfilParaHeartbeat, perfilParaPainel } = require('./perfil-de-vpn');
const { cifrar: cifrarSegredo } = require('./segredo-cifrado');
const cofre = require('./cofre-de-backup');
const { avaliarAtrasoDeBackup, explicarAtraso } = require('./atraso-de-backup');
const {
  normalizeCloudStorage,
  validateCloudStorage,
  describeCloudStorage,
  buildInstallationPayload: buildCloudStoragePayload,
  decryptSecret: decryptStorageSecret,
} = require('./cloud-storage');
const alertas = require('./alertas');
const releases = require('./releases');
const operations = require('./operations');
const { testS3Access, measureS3Performance, diagnosticarConexao, localizarServidor } = require('./s3-probe');
const { resolverEndpoint } = require('./endpoint-scheme');
const { ReactivationArchiveStore, expiresAfterMonths } = require('./reactivation-archives');
const firebaseManagement = require('./firebase-management');
const firebaseMessaging = require('./firebase-messaging');
const { selecionarVencidos } = require('./expiracao-de-arquivo');
const scheduler = require('./scheduler');
const timeseries = require('./datastore/timeseries');
const {
  clientIpFromRequest,
  compileTrustedProxies,
} = require('./proxy-trust');
const {
  InstallerConfigurationError,
  buildInstallerExecutionCommand,
  configuredInstallerArtifact,
  consumeInstallerDownload,
  installerTokenDigest,
  installerTokenMaxDownloads,
  installerTokenTtlMs,
  isInstallerTokenActive,
  issueInstallerGrant,
  sha256Text,
} = require('./installer-security');

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fsSync.existsSync(envPath)) return;
  const raw = fsSync.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const HOST = process.env.DRAC_CENTRAL_HOST || '0.0.0.0';
const PORT = Number(process.env.DRAC_CENTRAL_PORT || 9765);
const ADMIN_TOKEN = String(process.env.DRAC_CENTRAL_ADMIN_TOKEN || '').trim();
// Senha combinada que permite uma instalação NOVA se matricular sozinha.
// Vazia = matrícula desligada (recusa), nunca "aceita todo mundo".
const ENROLLMENT_TOKEN = String(process.env.DRAC_CENTRAL_ENROLLMENT_TOKEN || '').trim();
// Chave que cifra segredos de configuracao (senha de VPN, chave pre-compartilhada).
// Sem ela a cifra RECUSA trabalhar — nunca guarda em texto.
const SECRET_KEY = String(process.env.DRAC_CENTRAL_SECRET_KEY || '').trim();
// Onde ficam as copias das instalacoes. Fora do disco DELAS — que e o ponto.
const BACKUP_DIR = String(process.env.DRAC_CENTRAL_BACKUP_DIR || '/app/data/backups').trim();
// Quantas copias guardar por instalacao. Por CONTAGEM, nunca por idade.
const BACKUP_MANTER = Math.max(1, Number(process.env.DRAC_CENTRAL_BACKUP_KEEP || 7) || 7);
const ADMIN_EMAIL = String(process.env.DRAC_CENTRAL_ADMIN_EMAIL || 'admin@drac.local').trim().toLowerCase();
const ADMIN_PASSWORD_HASH = String(process.env.DRAC_CENTRAL_ADMIN_PASSWORD_HASH || '').trim();
const SESSION_TTL_MS = Math.max(1, Number(process.env.DRAC_CENTRAL_SESSION_HOURS || 8)) * 60 * 60 * 1000;
const DATA_FILE = path.resolve(process.cwd(), process.env.DRAC_CENTRAL_DATA_FILE || './data/installations.json');
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

const LICENSE_ACTIVE = 'ACTIVE';
const ONLINE_THRESHOLD_SECONDS = Number(process.env.DRAC_CENTRAL_ONLINE_THRESHOLD_SECONDS || 180);
const HEARTBEAT_HISTORY_LIMIT = Number(process.env.DRAC_CENTRAL_HISTORY_LIMIT || 100);
const AUDIT_HISTORY_LIMIT = Number(process.env.DRAC_CENTRAL_AUDIT_HISTORY_LIMIT || 500);
const ALERT_HISTORY_LIMIT = Number(process.env.DRAC_CENTRAL_ALERT_HISTORY_LIMIT || 500);
const LOGIN_WINDOW_MS = Math.max(1, Number(process.env.DRAC_CENTRAL_LOGIN_WINDOW_MINUTES || 15)) * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = Math.max(1, Number(process.env.DRAC_CENTRAL_LOGIN_MAX_ATTEMPTS || 8));
const ALLOWED_ORIGINS = String(process.env.DRAC_CENTRAL_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const TRUSTED_PROXIES = compileTrustedProxies(
  process.env.DRAC_CENTRAL_TRUSTED_PROXIES || '127.0.0.1/32,::1/128',
);
const loginAttempts = new Map();
const MAX_REQUEST_BODY_BYTES = Math.max(16 * 1024, Number(process.env.DRAC_CENTRAL_MAX_BODY_BYTES || 1024 * 1024));
const REQUEST_BODY_TIMEOUT_MS = Math.max(1_000, Number(process.env.DRAC_CENTRAL_BODY_TIMEOUT_MS || 15_000));
const requestBodyCache = new WeakMap();
const REACTIVATION_ARCHIVE_DIR = path.resolve(process.cwd(), process.env.DRAC_CENTRAL_ARCHIVE_DIR || './data/reactivation-archives');
const REACTIVATION_RETENTION_MONTHS = Math.max(1, Number(process.env.DRAC_CENTRAL_ARCHIVE_RETENTION_MONTHS || 24));
const ALLOWED_CENTRAL_PERMISSIONS = new Set([TECHNICAL_DOCUMENTATION_PERMISSION]);

function normalizeCentralPermissions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((permission) => String(permission || '').trim())
    .filter((permission) => ALLOWED_CENTRAL_PERMISSIONS.has(permission)))];
}

function reactivationArchiveStore() {
  return new ReactivationArchiveStore({
    directory: REACTIVATION_ARCHIVE_DIR,
    secret: process.env.DRAC_CENTRAL_ARCHIVE_KEY,
  });
}

function hasCentralPermission(actor, permission) {
  return Boolean(actor?.permissions?.includes(permission));
}

function canManageTechnicalAccess(actor) {
  return actor?.method === 'session' && actor?.accountKind === 'builtin';
}

// Scheduler multi-nó (fase 4) — DESLIGADO por default. Com a flag off as rotas
// nem são registradas: nada é lido, nada é escrito, e o registro de nós continua
// tão inerte quanto é hoje. Ligar exige DRAC_CENTRAL_SCHEDULER_ENABLED=true.
const SCHEDULER = scheduler.schedulerConfigFromEnv(process.env);

// Build-agent (gera os APKs white-label). Roda no HOST; a Central fala com ele
// pela gateway da bridge Docker. Token compartilhado (nunca exposto ao browser).
const APP_BUILDER_AGENT_URL = String(process.env.APP_BUILDER_AGENT_URL || '').replace(/\/+$/, '');
const APP_BUILDER_AGENT_TOKEN = String(process.env.APP_BUILDER_AGENT_TOKEN || '');
const APP_BUILDER_AGENT_TIMEOUT_MS = Math.min(
  120_000,
  Math.max(1_000, Number(process.env.APP_BUILDER_AGENT_TIMEOUT_MS || 15_000)),
);
const APP_BUILDER_AGENT_MAX_RESPONSE_BYTES = Math.min(
  10 * 1024 * 1024,
  Math.max(64 * 1024, Number(process.env.APP_BUILDER_AGENT_MAX_RESPONSE_BYTES || 1024 * 1024)),
);
// De onde a Central busca o APK publicado p/ reentregar com nome amigável.
// Mesma gateway usada p/ o agente; o web publica os APKs em /apk no :5173.
const APK_SOURCE_BASE = String(process.env.APK_SOURCE_BASE || 'http://172.17.0.1:5173').replace(/\/+$/, '');
const PUBLIC_APK_ROOT = String(process.env.PUBLIC_APK_BASE || 'https://s2cam.com.br').replace(/\/+$/, '');
const PUBLIC_APK_BASE = /\/apk$/i.test(PUBLIC_APK_ROOT) ? PUBLIC_APK_ROOT : `${PUBLIC_APK_ROOT}/apk`;
const MOBILE_CRASH_DSN = String(process.env.MOBILE_CRASH_DSN || '').trim();

// Jobs de instalação remota via SSH (em memória; o log é volátil por design —
// nunca persiste credenciais). jobId -> { id, installationId, status, log, ... }
const remoteInstalls = new Map();
const REMOTE_INSTALL_KEEP = 30;

function securityHeaders(req) {
  const origin = String(req?.headers?.origin || '');
  const allowAnyOrigin = ALLOWED_ORIGINS.includes('*');
  const allowedOrigin = allowAnyOrigin || !origin ? (allowAnyOrigin ? '*' : ALLOWED_ORIGINS[0]) : ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'access-control-allow-origin': allowedOrigin || ALLOWED_ORIGINS[0] || '*',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-drac-installation-id,x-drac-license-key',
    'access-control-allow-credentials': 'true',
  };
}

function json(req, res, statusCode, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(statusCode, {
    ...securityHeaders(req),
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(payload);
}

function text(req, res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    ...securityHeaders(req),
    'content-type': contentType,
  });
  res.end(body);
}

function empty(req, res, statusCode, extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...securityHeaders(req),
    ...extraHeaders,
  });
  res.end();
}

async function readBody(req) {
  if (requestBodyCache.has(req)) return requestBodyCache.get(req);
  const reading = (async () => {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        const error = new Error('Corpo da requisição excede o limite permitido.');
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return {};
    try { return JSON.parse(raw); } catch {
      const error = new Error('Corpo JSON inválido.');
      error.statusCode = 400;
      throw error;
    }
  })();
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Tempo limite excedido ao receber o corpo da requisição.');
      error.statusCode = 408;
      reject(error);
    }, REQUEST_BODY_TIMEOUT_MS);
    timer.unref();
    reading.finally(() => clearTimeout(timer)).catch(() => undefined);
  });
  const result = Promise.race([reading, timeout]);
  requestBodyCache.set(req, result);
  return result;
}

function parseDbText(raw) {
  if (!raw || !raw.trim()) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

function normalizeDb(parsed) {
  if (!parsed || typeof parsed !== 'object') parsed = {};
  if (!parsed.installations || typeof parsed.installations !== 'object') parsed.installations = {};
  if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};
  if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
  for (const item of Object.values(parsed.installations)) {
    if (item && typeof item === 'object') delete item.installerToken;
  }
  return parsed;
}

// legacyLoadDb NUNCA lança: arquivo corrompido derrubava o processo em qualquer
// request (login/heartbeat) num loop de crash. Agora cai pro .bak e, em último caso,
// isola o arquivo corrompido e começa limpo — a Central continua de pé.
// (É a fonte JSON legada; em modo Postgres vira read-only, janela de rollback.)
async function legacyLoadDb() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = parseDbText(raw);
    if (parsed) return normalizeDb(parsed);
  } catch (error) {
    if (error && error.code === 'ENOENT') return normalizeDb({});
    console.error(`[central] ${DATA_FILE} ilegível/corrompido: ${error.message}`);
  }
  // Tentativa de recuperação pelo backup conhecido-bom.
  try {
    const bak = await fs.readFile(`${DATA_FILE}.bak`, 'utf8');
    const parsed = parseDbText(bak);
    if (parsed) {
      console.error('[central] recuperado a partir de .bak');
      return normalizeDb(parsed);
    }
  } catch { /* sem backup utilizável */ }
  // Último recurso: isola o arquivo corrompido e segue com base limpa.
  try {
    if (fsSync.existsSync(DATA_FILE)) {
      const quarantine = `${DATA_FILE}.corrupt-${Date.now()}`;
      await fs.copyFile(DATA_FILE, quarantine);
      console.error(`[central] arquivo corrompido isolado em ${quarantine}; iniciando base limpa`);
    }
  } catch { /* ignore */ }
  return normalizeDb({});
}

// legacySaveDb atômico: grava em .tmp e faz rename (atômico no mesmo FS), evitando
// o arquivo meio-escrito que corrompia em crash/escrita concorrente. Antes de
// sobrescrever, guarda o último estado VÁLIDO em .bak (rede de segurança).
async function legacySaveDb(db) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    const current = await fs.readFile(DATA_FILE, 'utf8');
    const parsedCurrent = parseDbText(current);
    if (parsedCurrent) {
      const sanitizedCurrent = JSON.stringify(normalizeDb(parsedCurrent), null, 2);
      await fs.writeFile(`${DATA_FILE}.bak`, sanitizedCurrent, { mode: 0o600 });
      await fs.chmod(`${DATA_FILE}.bak`, 0o600);
    }
  } catch { /* sem arquivo atual ainda, ou ilegível: ignora o backup */ }
  // Nome único também protege contra duas instâncias acidentalmente apontando
  // para o mesmo volume (ou uma rota não serializada no futuro).
  const tmp = `${DATA_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(normalizeDb(db), null, 2), { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, DATA_FILE);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

// ── Datastore plugável (item 2.10): JSON | Postgres dual-read | Postgres ──────
// Sem DRAC_CENTRAL_DATABASE_URL, loadDb/saveDb são passthrough p/ o JSON legado
// (comportamento atual, DEFAULT). Com URL, a Central lê do Postgres (dual-read cai
// para o JSON legado read-only) e escreve só no Postgres — sem tocar nas rotas.
let _datastore = null;
function getDatastore() {
  if (!_datastore) {
    _datastore = createDatastore({
      legacy: { load: legacyLoadDb, save: legacySaveDb },
      config: resolveConfig(process.env),
    });
    if (_datastore.mode !== 'json') {
      console.log(`[central] datastore em modo "${_datastore.mode}" (Postgres); JSON legado read-only.`);
    }
  }
  return _datastore;
}

async function loadDb() {
  return normalizeDb(await getDatastore().load());
}

async function saveDb(db) {
  return getDatastore().save(db);
}

// ── Série temporal (histórico REAL da frota) ────────────────────────────────
// SÓ existe com Postgres configurado. No DEFAULT (JSON), getTimeseries() devolve
// o NO-OP: `enabled === false` e todos os caminhos abaixo saem na primeira linha
// — nenhuma consulta, nenhum log, nenhum custo. A Central segue como hoje.
function getTimeseries() {
  return getDatastore().timeseries;
}

// Nunca deixa a série temporal derrubar a rota que a chamou: heartbeat aceito é
// mais importante que amostra gravada.
async function withTimeseries(action, label) {
  const store = getTimeseries();
  if (!store || !store.enabled) return null;
  try {
    return await action(store);
  } catch (error) {
    console.error(`[central] série temporal (${label}) falhou:`, error && error.message ? error.message : error);
    return null;
  }
}

// Bloco `cameras` do heartbeat: OPCIONAL. A instalação manda
// { totals, staleThresholdSeconds, omitted, items[] } — a lista pode vir
// TRUNCADA por gravidade, e por isso `totals` (da frota inteira) é o que vale
// para os números. Devolvemos o bloco CRU; quem precisa da lista normaliza.
function heartbeatCameraRaw(body) {
  if (!body || typeof body !== 'object') return null;
  const block = body.cameras ?? body.cameraHealth ?? (body.observability && body.observability.cameras);
  return block === undefined || block === null ? null : block;
}

// `null` = bloco não veio (não mexe no estado por câmera); array (mesmo vazio)
// = veio e é o estado exato.
function heartbeatCameraBlock(body) {
  const block = heartbeatCameraRaw(body);
  return block === null ? null : timeseries.parseCameraHealth(block);
}

function timingSafeTextEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(password, encodedHash) {
  const [scheme, iterationsRaw, salt, hash] = String(encodedHash || '').split('$');
  if (scheme !== 'pbkdf2_sha256' || !iterationsRaw || !salt || !hash) return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  const derived = crypto.pbkdf2Sync(String(password || ''), salt, iterations, 32, 'sha256').toString('hex');
  return timingSafeTextEquals(derived, hash);
}

function hashPassword(password) {
  const iterations = 600000;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function isStrongPassword(password) {
  const value = String(password || '');
  return value.length >= 12
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /\d/.test(value);
}

// Autentica contra o admin do .env OU um usuário cadastrado (db.users).
function authenticate(db, email, password) {
  if (ADMIN_PASSWORD_HASH && email === ADMIN_EMAIL && verifyPassword(password, ADMIN_PASSWORD_HASH)) {
    return {
      email: ADMIN_EMAIL,
      name: 'Administrador',
      builtin: true,
      permissions: [TECHNICAL_DOCUMENTATION_PERMISSION],
      authVersion: crypto.createHash('sha256').update(ADMIN_PASSWORD_HASH).digest('hex'),
    };
  }
  const u = db.users && db.users[email];
  if (u && verifyPassword(password, u.passwordHash)) {
    return {
      email,
      name: u.name || email,
      builtin: false,
      permissions: normalizeCentralPermissions(u.permissions),
      authVersion: Number.isInteger(u.authVersion) ? u.authVersion : 1,
    };
  }
  return null;
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = {};
  for (const item of header.split(';')) {
    const index = item.indexOf('=');
    if (index === -1) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function sessionHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionCookie(token, maxAgeSeconds) {
  const secure = String(process.env.DRAC_CENTRAL_COOKIE_SECURE || 'true').toLowerCase() !== 'false' ? '; Secure' : '';
  return `drac_central_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearSessionCookie() {
  const secure = String(process.env.DRAC_CENTRAL_COOKIE_SECURE || 'true').toLowerCase() !== 'false' ? '; Secure' : '';
  return `drac_central_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function clientIp(req) {
  return clientIpFromRequest(req, TRUSTED_PROXIES);
}

function loginAttemptKey(req, email) {
  return `${clientIp(req)}:${String(email || '').trim().toLowerCase()}`;
}

function loginRateLimitStatus(req, email) {
  const key = loginAttemptKey(req, email);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    const next = { firstAt: now, count: 0 };
    loginAttempts.set(key, next);
    return { key, blocked: false, entry: next };
  }
  return { key, blocked: entry.count >= LOGIN_MAX_ATTEMPTS, entry };
}

function recordLoginFailure(key, entry) {
  entry.count += 1;
  loginAttempts.set(key, entry);
}

function resetLoginFailures(key) {
  loginAttempts.delete(key);
}

/**
 * Carimbo da versão SERVIDA, derivado da data do arquivo que o navegador baixa.
 *
 * Deliberadamente não é a versão do package.json: o que importa aqui não é o
 * número da release, é se o HTML/JS na tela do operador é o mesmo que está no
 * disco. Um deploy que só troca a página não muda a versão do pacote, e é
 * exatamente nesse caso que a dúvida aparece.
 *
 * Calculado a cada chamada porque o arquivo é montado por bind mount e pode
 * mudar sob o processo em execução, sem reinício.
 */
function buildStamp() {
  try {
    const alvo = path.join(__dirname, '..', 'public', 'index.html');
    return new Date(fsSync.statSync(alvo).mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return 'desconhecido';
  }
}

function addAuditEvent(db, req, event) {
  const auditEvents = Array.isArray(db.auditEvents) ? db.auditEvents : [];
  auditEvents.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 240),
    ...event,
  });
  while (auditEvents.length > AUDIT_HISTORY_LIMIT) auditEvents.shift();
  db.auditEvents = auditEvents;
}

function slugify(value) {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return normalized || `cliente-${crypto.randomBytes(4).toString('hex')}`;
}

function publicBaseUrl(req) {
  const configured = String(process.env.DRAC_CENTRAL_PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`).split(',')[0].trim();
  const prefix = String(req.headers['x-forwarded-prefix'] || '').split(',')[0].trim().replace(/\/+$/, '');
  return `${proto}://${host}${prefix && prefix.startsWith('/') ? prefix : ''}`;
}

function installerConfigurationResponse(req, res) {
  return json(req, res, 503, {
    error: 'installer_artifact_not_configured',
    message:
      'O instalador exige URL pública HTTPS, commit imutável e SHA-256 válido.',
  });
}

function installerEnvironment(item, centralUrl) {
  return {
    DRAC_CUSTOMER_NAME: item.customerName || item.id,
    DRAC_INSTALLATION_ID: item.id,
    DRAC_LICENSE_KEY: item.licenseKey,
    DRAC_SERVER_IP: item.provisionedServerAddress || '',
    DRAC_CENTRAL_URL: centralUrl,
    DRAC_INSTALLER_COMMIT: item.installerArtifact.commit || item.installerArtifact.id,
    DRAC_REPO_URL: item.installerArtifact.repositoryUrl,
    // A política de egress das câmeras depende da topologia local — a Central
    // não a INVENTA, mas ela pode ser INFORMADA no provisionamento. Sem isso a
    // instalação remota nunca era desassistida: o script parava perguntando as
    // redes das câmeras e ficava esperando alguém digitar NO SERVIDOR do
    // cliente, o que anula o sentido de instalar pelo painel (19/08/2026).
    ...(item.cameraAllowedCidrs
      ? { DRAC_CAMERA_ALLOWED_CIDRS: item.cameraAllowedCidrs }
      : {}),
    // Só entra em modo automático quando NADA ficou por perguntar.
    DRAC_AUTO_YES: item.cameraAllowedCidrs ? 'true' : 'false',
  };
}

function buildApprovedInstallerCommand(item, centralUrl) {
  return buildInstallerExecutionCommand({
    artifact: item.installerArtifact,
    environment: installerEnvironment(item, centralUrl),
    allowInsecureLoopback:
      String(process.env.DRAC_CENTRAL_ALLOW_INSECURE_INSTALLER_URL || '') ===
      'true',
  });
}

function buildInstallerScript(item, centralUrl) {
  const command = buildApprovedInstallerCommand(item, centralUrl);
  return `#!/usr/bin/env bash
set -Eeuo pipefail

${command}
`;
}

function buildQuickInstallCommand({
  centralUrl,
  installationId,
  installerScriptSha256,
}) {
  const quickInstallUrl = `${centralUrl}/install/${encodeURIComponent(installationId)}`;
  return buildInstallerExecutionCommand({
    artifact: {
      id: installerScriptSha256,
      url: quickInstallUrl,
      sha256: installerScriptSha256,
    },
    bearerInput: 'prompt',
    // A Central deve ser HTTPS. HTTP só é aceito em loopback para testes locais.
    allowInsecureLoopback: true,
  });
}

function buildInstallerResponse(item, centralUrl, installerToken) {
  if (
    !isInstallerTokenActive(item) ||
    !installerToken ||
    !timingSafeTextEquals(
      item.installerTokenHash,
      installerTokenDigest(installerToken),
    )
  ) {
    throw new InstallerConfigurationError(
      'O token do instalador está ausente ou expirado.',
    );
  }
  const installerScript = buildInstallerScript(item, centralUrl);
  const installerScriptSha256 = sha256Text(installerScript);
  const installCommand = buildQuickInstallCommand({
    centralUrl,
    installationId: item.id,
    installerScriptSha256,
  });
  return {
    licenseKey: item.licenseKey,
    centralUrl,
    serverAddress: item.provisionedServerAddress || null,
    installCommand,
    installerToken,
    quickInstallUrl: `${centralUrl}/install/${encodeURIComponent(item.id)}`,
    installerArtifact: {
      id: item.installerArtifact.id,
      url: item.installerArtifact.url,
      repositoryUrl: item.installerArtifact.repositoryUrl,
      sha256: item.installerArtifact.sha256,
      compatibility: item.installerArtifact.compatibility,
      boundAt: item.installerArtifact.boundAt,
    },
    installerTokenExpiresAt: item.installerTokenExpiresAt,
    installerTokenRemainingDownloads: item.installerTokenRemainingDownloads,
  };
}

function refreshInstallerGrant(
  item,
  {
    forceArtifact = false,
    forceToken = false,
    issueToken = true,
    now = new Date(),
    release = null,
  } = {},
) {
  // REVINCULA quando a versão aprovada mudou. Antes só vinculava se o artefato
  // não existisse, então instalação já provisionada ficava presa ao commit
  // antigo para sempre — promover não mudava o que era instalado (19/08/2026).
  const desatualizado = Boolean(
    release?.commit && item.installerArtifact && item.installerArtifact.id !== release.commit,
  );
  const bindConfiguredArtifact = forceArtifact || !item.installerArtifact || desatualizado;
  const artifact = bindConfiguredArtifact
    ? configuredInstallerArtifact(process.env, now, release)
    : item.installerArtifact;
  const result = issueInstallerGrant(item, {
    artifact,
    now,
    ttlMs: installerTokenTtlMs(process.env),
    maxDownloads: installerTokenMaxDownloads(process.env),
    rotateArtifact: bindConfiguredArtifact,
    createToken: issueToken,
    rotateToken:
      issueToken &&
      (forceToken || bindConfiguredArtifact || !isInstallerTokenActive(item, now)),
  });
  return result.installerToken;
}

function cleanExpiredSessions(db) {
  const now = Date.now();
  for (const [key, session] of Object.entries(db.sessions || {})) {
    if (!session?.expiresAt || new Date(session.expiresAt).getTime() <= now) {
      delete db.sessions[key];
    }
  }
}

function revokeUserSessions(db, email) {
  let revoked = 0;
  for (const [key, session] of Object.entries(db.sessions || {})) {
    if (session?.email === email) {
      delete db.sessions[key];
      revoked += 1;
    }
  }
  return revoked;
}

function getAuthenticatedUser(req, db) {
  const header = String(req.headers.authorization || '');
  // timing-safe: acertar este token é bypass TOTAL de autenticação da Central.
  if (ADMIN_TOKEN && timingSafeTextEquals(header, `Bearer ${ADMIN_TOKEN}`)) {
    return {
      email: 'api-token',
      method: 'bearer',
      accountKind: 'bearer',
      permissions: [],
      canManageTechnicalAccess: false,
    };
  }
  cleanExpiredSessions(db);
  const token = parseCookies(req).drac_central_session;
  if (!token) return null;
  const key = sessionHash(token);
  const session = db.sessions?.[key];
  if (!session) return null;
  const expiresAt = new Date(session.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    delete db.sessions[key];
    return null;
  }
  if (session.accountKind === 'builtin') {
    const currentVersion = crypto
      .createHash('sha256')
      .update(ADMIN_PASSWORD_HASH)
      .digest('hex');
    if (
      session.email !== ADMIN_EMAIL ||
      !ADMIN_PASSWORD_HASH ||
      !timingSafeTextEquals(session.authVersion || '', currentVersion)
    ) {
      delete db.sessions[key];
      return null;
    }
    session.lastSeenAt = new Date().toISOString();
    return {
      email: session.email,
      method: 'session',
      accountKind: 'builtin',
      permissions: [TECHNICAL_DOCUMENTATION_PERMISSION],
      canManageTechnicalAccess: true,
    };
  } else {
    const account = db.users?.[session.email];
    const currentVersion = Number.isInteger(account?.authVersion)
      ? account.authVersion
      : 1;
    if (!account || session.authVersion !== currentVersion) {
      delete db.sessions[key];
      return null;
    }
    session.lastSeenAt = new Date().toISOString();
    return {
      email: session.email,
      method: 'session',
      accountKind: 'user',
      permissions: normalizeCentralPermissions(account.permissions),
      canManageTechnicalAccess: false,
    };
  }
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const limit = loginRateLimitStatus(req, email);
  const db = await loadDb();
  cleanExpiredSessions(db);
  if (limit.blocked) {
    addAuditEvent(db, req, { type: 'auth.login_blocked', actor: email || 'unknown', result: 'blocked' });
    await saveDb(db);
    return json(req, res, 429, { error: 'too_many_attempts', message: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
  }
  const account = authenticate(db, email, password);
  if (!account) {
    recordLoginFailure(limit.key, limit.entry);
    addAuditEvent(db, req, { type: 'auth.login_failed', actor: email || 'unknown', result: 'denied' });
    await saveDb(db);
    return json(req, res, 401, { error: 'invalid_credentials', message: 'E-mail ou senha inválidos.' });
  }

  resetLoginFailures(limit.key);
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.sessions[sessionHash(token)] = {
    email: account.email,
    accountKind: account.builtin ? 'builtin' : 'user',
    authVersion: account.authVersion,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  addAuditEvent(db, req, { type: 'auth.login_success', actor: account.email, result: 'accepted' });
  await saveDb(db);

  return json(
    req,
    res,
    200,
    {
      user: {
        email: account.email,
        name: account.name,
        role: 'ADMIN',
        method: 'session',
        accountKind: account.builtin ? 'builtin' : 'user',
        permissions: normalizeCentralPermissions(account.permissions),
        canManageTechnicalAccess: Boolean(account.builtin),
      },
      expiresAt: expiresAt.toISOString(),
    },
    { 'set-cookie': sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)) },
  );
}

async function handleLogout(req, res) {
  const db = await loadDb();
  const user = getAuthenticatedUser(req, db);
  const token = parseCookies(req).drac_central_session;
  if (token) delete db.sessions[sessionHash(token)];
  addAuditEvent(db, req, { type: 'auth.logout', actor: user?.email || 'unknown', result: 'accepted' });
  await saveDb(db);
  return json(req, res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
}

async function handleMe(req, res) {
  const db = await loadDb();
  const user = getAuthenticatedUser(req, db);
  await saveDb(db);
  if (!user) return json(req, res, 200, { authenticated: false, user: null });
  return json(req, res, 200, {
    authenticated: true,
    user: {
      email: user.email,
      role: 'ADMIN',
      method: user.method,
      accountKind: user.accountKind,
      permissions: user.permissions,
      canManageTechnicalAccess: user.canManageTechnicalAccess,
    },
  });
}

function metricValue(item, key, fallback = null) {
  const metrics = item.metrics || {};
  if (metrics[key] !== undefined && metrics[key] !== null) return metrics[key];
  if (key === 'cameraTotal') return metrics.cameras?.total ?? fallback;
  if (key === 'cameraOnline') return metrics.cameras?.online ?? fallback;
  if (key === 'cameraOffline') return metrics.cameras?.offline ?? fallback;
  if (key === 'cameraError') return metrics.cameras?.error ?? fallback;
  if (key === 'diskUsagePercent') return metrics.disk?.usagePercent ?? fallback;
  return fallback;
}

function alertKey(alert) {
  const informedKey = String(alert?.key || '').trim().toLowerCase().slice(0, 160);
  if (informedKey) return informedKey;
  const code = String(alert?.code || 'generic').trim().toLowerCase();
  if (code !== 'generic') return code;
  const message = String(alert?.message || '').trim().toLowerCase().slice(0, 120);
  return `${code}:${message}`;
}

function alertLevelRank(level) {
  return level === 'critical' ? 2 : 1;
}

/**
 * Atualiza o histórico E devolve as TRANSIÇÕES do ciclo.
 *
 * As transições são o que dá deduplicação de graça no aviso: um alerta que já
 * estava ACTIVE e continua ACTIVE não produz transição nenhuma, então não
 * gera mensagem. Sem isso, um disco cheio viraria um aviso a cada heartbeat —
 * 60 mensagens por hora, e o operador silencia o canal justamente antes da
 * próxima ocorrência que importava.
 *
 * `novos` cobre os dois casos que merecem aviso: alerta inédito e alerta que
 * tinha sido resolvido e VOLTOU (reincidência é informação, não repetição).
 */
/**
 * Manda os avisos dos alertas que MUDARAM de estado neste heartbeat.
 *
 * Best-effort por contrato: nada aqui pode derrubar o processamento do
 * heartbeat, que é o que mantém a frota visível. Falha de canal vira log e
 * segue — e um canal quebrado não impede o outro (ver despacharAlerta).
 */
function despacharAlertasDaInstalacao(item, novos, resolvidos) {
  const config = alertas.normalizarAlertas(item.alertChannels);
  if (!config.telegramEnabled && !config.emailEnabled) return;

  void (async () => {
    try {
      if (novos.length) {
        const resultados = await alertas.despacharAlerta(config, alertas.montarMensagem({ instalacao: item, alertas: novos }));
        registrarFalhasDeEntrega(item, resultados);
      }
      if (resolvidos.length && config.avisarRecuperacao) {
        const resultados = await alertas.despacharAlerta(
          config,
          alertas.montarMensagem({ instalacao: item, alertas: resolvidos, recuperado: true }),
        );
        registrarFalhasDeEntrega(item, resultados);
      }
    } catch (erro) {
      console.error(`[alertas] falha ao avisar instalacao=${item.id}: ${erro?.message || erro}`);
    }
  })();
}

function registrarFalhasDeEntrega(item, resultados) {
  for (const resultado of Array.isArray(resultados) ? resultados : []) {
    if (resultado?.ok) continue;
    const canal = resultado?.canal === 'email' ? 'e-mail' : 'Telegram';
    const motivo = String(resultado?.erro || 'falha sem detalhe').replace(/[\r\n]+/g, ' ').slice(0, 240);
    console.error(`[alertas] ${canal} não entregue instalacao=${item.id}: ${motivo}`);
  }
}

function updateAlertHistory(existing, alerts, now) {
  const history = Array.isArray(existing.alertHistory) ? existing.alertHistory.slice() : [];
  const activeKeys = new Set(alerts.map(alertKey));
  const indexByKey = new Map();
  history.forEach((entry, index) => {
    indexByKey.set(entry.key, index);
    // Migra sem novo disparo as chaves antigas (`code:mensagem`). A versão
    // anterior incluía percentual/contagem no identificador; ao atualizar a
    // Central, um problema que já estava ativo não pode parecer inédito.
    const canonical = alertKey(alertas.normalizarAlertaOperacional({
      code: entry.code,
      level: entry.level,
      message: entry.message,
    }));
    if (!indexByKey.has(canonical)) indexByKey.set(canonical, index);
  });
  const novos = [];
  const resolvidos = [];

  for (const alert of alerts) {
    const key = alertKey(alert);
    const previousIndex = indexByKey.get(key);
    if (previousIndex == null) {
      novos.push({ key, level: alert.level || 'warning', code: alert.code || 'generic', message: alert.message || 'Alerta operacional.' });
      history.push({
        id: crypto.randomUUID(),
        key,
        status: 'ACTIVE',
        level: alert.level || 'warning',
        code: alert.code || 'generic',
        message: alert.message || 'Alerta operacional.',
        firstSeenAt: now,
        lastSeenAt: now,
        resolvedAt: null,
        occurrences: 1,
      });
      continue;
    }
    const entry = history[previousIndex];
    const escalated = entry.status === 'ACTIVE'
      && alertLevelRank(alert.level) > alertLevelRank(entry.level);
    if (entry.status !== 'ACTIVE' || escalated) {
      novos.push({ key, level: alert.level || entry.level || 'warning', code: alert.code || entry.code || 'generic', message: alert.message || entry.message || 'Alerta operacional.' });
    }
    entry.status = 'ACTIVE';
    entry.key = key;
    entry.level = alert.level || entry.level || 'warning';
    entry.code = alert.code || entry.code || 'generic';
    entry.message = alert.message || entry.message || 'Alerta operacional.';
    entry.lastSeenAt = now;
    entry.resolvedAt = null;
    entry.occurrences = Number(entry.occurrences || 0) + 1;
  }

  for (const entry of history) {
    if (entry.status === 'ACTIVE' && !activeKeys.has(entry.key)) {
      entry.status = 'RESOLVED';
      entry.resolvedAt = now;
      resolvidos.push({ key: entry.key, level: entry.level, code: entry.code, message: entry.message });
    }
  }

  const ordenado = history
    .sort((a, b) => new Date(b.lastSeenAt || b.firstSeenAt || 0).getTime() - new Date(a.lastSeenAt || a.firstSeenAt || 0).getTime())
    .slice(0, ALERT_HISTORY_LIMIT);

  return { history: ordenado, novos, resolvidos };
}

/**
 * O heartbeat não consegue avisar a própria ausência. Este passo é executado
 * pela Central e acrescenta o alerta de comunicação sem resolver os demais
 * problemas que ficaram ativos no último heartbeat.
 */
function updateConnectivityAlert(item, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const last = item?.lastHeartbeatAt ? new Date(item.lastHeartbeatAt) : null;
  if (!last || !Number.isFinite(last.getTime()) || !Number.isFinite(current.getTime())) {
    return { changed: false, history: item?.alertHistory || [], novos: [] };
  }
  const ageSeconds = Math.floor((current.getTime() - last.getTime()) / 1000);
  if (ageSeconds <= ONLINE_THRESHOLD_SECONDS) {
    return { changed: false, history: item?.alertHistory || [], novos: [] };
  }

  const history = Array.isArray(item.alertHistory) ? item.alertHistory : [];
  if (history.some((entry) => entry?.status === 'ACTIVE' && entry?.key === 'installation_connectivity')) {
    return { changed: false, history, novos: [] };
  }

  const active = history
    .filter((entry) => entry?.status === 'ACTIVE' && entry?.key !== 'installation_connectivity')
    .map((entry) => ({ key: entry.key, level: entry.level, code: entry.code, message: entry.message }));
  const minutes = Math.max(1, Math.floor(ageSeconds / 60));
  active.push(alertas.normalizarAlertaOperacional({
    key: 'installation_connectivity',
    level: 'critical',
    code: 'installation_offline',
    message: `A instalação não envia informações à Central há ${minutes} minutos. A equipe deve verificar a internet e o servidor local.`,
  }));
  const result = updateAlertHistory(item, active, current.toISOString());
  return { changed: result.novos.length > 0, history: result.history, novos: result.novos };
}

function startConnectivityMonitor() {
  const intervalMs = Math.max(15_000, Math.min(60_000, Math.floor(ONLINE_THRESHOLD_SECONDS * 1000 / 3)));
  const run = () => {
    void runSerialized(async () => {
      const db = await loadDb();
      const notifications = [];
      let changed = false;
      const now = new Date();
      for (const item of Object.values(db.installations || {})) {
        const result = updateConnectivityAlert(item, now);
        if (!result.changed) continue;
        item.alertHistory = result.history;
        notifications.push({ item, alerts: result.novos });
        changed = true;
      }
      if (!changed) return;
      await saveDb(db);
      for (const notification of notifications) {
        despacharAlertasDaInstalacao(notification.item, notification.alerts, []);
      }
    }).catch((error) => {
      console.error(`[alertas] falha ao verificar comunicação das instalações: ${error?.message || error}`);
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  run();
  return timer;
}

/** A versão aprovada da frota, ou null enquanto ninguém promoveu nada. */
function releaseAtual(db) {
  return db?.release?.commit ? db.release : null;
}

function publicInstallation(item, release = null) {
  const lastHeartbeatAt = item.lastHeartbeatAt ? new Date(item.lastHeartbeatAt).getTime() : 0;
  const updatedAt = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
  const ageSeconds = lastHeartbeatAt ? Math.round((Date.now() - lastHeartbeatAt) / 1000) : null;
  // PENDÊNCIA REAL: a revisão desejada ainda não foi confirmada como aplicada.
  //
  // A regra anterior (`updatedAt > lastHeartbeatAt`) só provava que a instalação
  // esteve online depois da mudança. Agora comparamos revisões, e o caso
  // perigoso — instalação que não reporta estado — fica VISÍVEL como
  // 'UNSUPPORTED' em vez de sumir da lista de pendências.
  const desiredRevision = Number(item.configRevision || 0) || 0;
  const appliedRevision = Number(item.appliedConfigRevision || 0) || 0;
  const applyStatus = item.configApplyStatus || 'UNKNOWN';
  const policyPending = desiredRevision > 0
    ? (appliedRevision < desiredRevision || applyStatus === 'FAILED')
    // Sem revisão emitida ainda: mantém o critério antigo para não mudar o
    // comportamento de instalações que nunca receberam configuração nova.
    : Boolean(updatedAt && lastHeartbeatAt && updatedAt > lastHeartbeatAt);
  const status = ageSeconds == null ? 'PENDING_INSTALL' : ageSeconds <= ONLINE_THRESHOLD_SECONDS ? 'ONLINE' : 'OFFLINE';
  // Nós de computação (item 3.2): campo OMITIDO quando não há nós definidos, para
  // preservar exatamente a saída atual das instalações single-primary (retrocompat).
  const computeNodes = normalizeComputeNodes(item.computeNodes);
  return {
    id: item.id,
    name: item.name,
    customerName: item.customerName,
    status,
    ageSeconds,
    licenseStatus: item.licenseStatus || LICENSE_ACTIVE,
    licenseMessage: item.licenseMessage || null,
    licensePlan: normalizePlan(item.licensePlan),
    resourceLimits: limitsFor(item),
    resourceUsage: usageFor(item),
    maxCameras: tetoParaHeartbeat(item.maxCameras),
    maxUsers: tetoParaHeartbeat(item.maxUsers),
    maxRetentionDays: tetoParaHeartbeat(item.maxRetentionDays),
    restrictions: licenseResponse(item).restrictions,
    policyPending,
    launchProfile: item.launchProfile || item.metrics?.launchProfile || null,
    version: item.version || null,
    operations: operations.operationList(item).slice().reverse().slice(0, 12).map(operations.publicOperation),
    operationsAgentLastSeenAt: item.operationsAgentLastSeenAt || null,
    // Onde esta instalação está em relação à versão APROVADA da frota.
    // `desconhecida` (nunca reportou versão) é diferente de `atrasada`: o
    // operador precisa ver que não se sabe, em vez de supor.
    versaoSituacao: releases.situacaoDaInstalacao(item, release),
    lastHeartbeatAt: item.lastHeartbeatAt || null,
    metrics: item.metrics || {},
    alerts: item.alerts || [],
    alertHistory: Array.isArray(item.alertHistory) ? item.alertHistory : [],
    server: item.server || null,
    storage: item.storage || null,
    production: item.production || null,
    heartbeatHistory: Array.isArray(item.heartbeatHistory) ? item.heartbeatHistory : [],
    licenseHistory: Array.isArray(item.licenseHistory) ? item.licenseHistory.slice(-30) : [],
    provisionedAt: item.provisionedAt || null,
    provisionedBy: item.provisionedBy || null,
    provisionedServerAddress: item.provisionedServerAddress || null,
    app: item.app || null,
    updatedAt: item.updatedAt || null,
    ...(computeNodes.length ? { computeNodes } : {}),
    // Liga/desliga do scheduler POR INSTALAÇÃO, editável pelo painel. Sempre
    // presente (booleano) para a tela poder desenhar o estado do interruptor sem
    // adivinhar; ausente no registro = desligado.
    schedulerEnabled: item.schedulerEnabled === true,
    // Política de IA sempre presente (normalizada) para a tela desenhar os
    // interruptores sem adivinhar o que "ausente" significa.
    aiPolicy: normalizeAiPolicy(item.aiPolicy),
    // Storage em nuvem SEM a credencial: `describeCloudStorage` remove o
    // segredo e devolve só `hasSecret`. O painel nunca precisa da chave; quem
    // precisa dela é a instalação, e ela a recebe pelo heartbeat.
    // `alertasPublicos` NUNCA devolve o token do bot, nem cifrado.
    alertas: alertas.alertasPublicos(item.alertChannels),
    cloudStorage: describeCloudStorage(item.cloudStorage),
    reactivationArchive: item.reactivationArchive ? { ...item.reactivationArchive } : null,
    reactivationRestore: item.reactivationRestore ? { ...item.reactivationRestore } : null,
    // Estado de entrega da configuração, para a tela dizer a verdade em vez de
    // "pendente/não pendente" sem explicação.
    configDelivery: {
      desiredRevision,
      appliedRevision,
      status: applyStatus,
      error: item.configApplyError || null,
      at: item.configApplyAt || null,
      supports: Array.isArray(item.supportedConfigKeys) ? item.supportedConfigKeys : null,
    },
  };
}

function authenticateInstallationRequest(req, db) {
  const installationId = String(req.headers['x-drac-installation-id'] || '').trim();
  const licenseKey = String(req.headers['x-drac-license-key'] || '').trim();
  if (!installationId || !licenseKey) return { error: 'missing_installation_or_license', http: 401 };
  const installation = db.installations?.[installationId];
  if (!installation) return { error: 'unknown_installation', http: 403 };
  if (!timingSafeTextEquals(installation.licenseKey || '', licenseKey)) return { error: 'invalid_license_key', http: 403 };
  return { installationId, installation };
}

function fleetSummary(installations) {
  const items = installations.map(publicInstallation);
  const totals = items.reduce((acc, item) => {
    const cameraTotal = Number(metricValue(item, 'cameraTotal', 0) || 0);
    const cameraOnline = Number(metricValue(item, 'cameraOnline', 0) || 0);
    const cameraOffline = Number(metricValue(item, 'cameraOffline', 0) || 0);
    const cameraError = Number(metricValue(item, 'cameraError', 0) || 0);
    const diskUsagePercent = Number(metricValue(item, 'diskUsagePercent', 0) || 0);
    const openAlarms = Number(item.metrics?.openAlarms || 0);
    const hasAttention =
      item.status !== 'ONLINE' ||
      item.licenseStatus === 'RESTRICTED' ||
      item.licenseStatus === 'SUSPENDED' ||
      item.metrics?.productionReadiness === 'blocked' ||
      item.metrics?.productionReadiness === 'attention' ||
      cameraOffline + cameraError > 0 ||
      diskUsagePercent >= 85 ||
      openAlarms > 0;

    acc.installations += 1;
    acc.online += item.status === 'ONLINE' ? 1 : 0;
    acc.offline += item.status === 'OFFLINE' ? 1 : 0;
    acc.pendingInstall += item.status === 'PENDING_INSTALL' ? 1 : 0;
    acc.attention += hasAttention ? 1 : 0;
    acc.suspended += item.licenseStatus === 'SUSPENDED' ? 1 : 0;
    acc.restricted += item.licenseStatus === 'RESTRICTED' ? 1 : 0;
    acc.cameraTotal += cameraTotal;
    acc.cameraOnline += cameraOnline;
    acc.cameraOffline += cameraOffline;
    acc.cameraError += cameraError;
    acc.openAlarms += openAlarms;
    acc.streamHighCpuRiskCameras += Number(item.metrics?.streamHighCpuRiskCameras || 0);
    acc.streamLiveTranscodeLikely += Number(item.metrics?.streamLiveTranscodeLikely || 0);
    acc.streamLiveFailuresLast24h += Number(item.metrics?.streamLiveFailuresLast24h || 0);
    acc.streamOptimizationSafeActions += Number(item.metrics?.streamOptimizationSafeActions || 0);
    acc.recordingGapSecondsLast24h += Number(item.metrics?.recordingGapSecondsLast24h || 0);
    acc.recordingAttentionCameras += Number(item.metrics?.recordingAttentionCameras || 0);
    acc.maxDiskUsagePercent = Math.max(acc.maxDiskUsagePercent, diskUsagePercent);
    // Nós de computação (item 3.2): agregados aditivos. Sem nós → não conta como
    // "configured" (single-primary implícito) — retrocompat total do resumo.
    const nodeSummary = summarizeNodes(item.computeNodes);
    acc.computeNodesConfigured += nodeSummary.configured ? 1 : 0;
    acc.computeNodesTotal += nodeSummary.total;
    return acc;
  }, {
    installations: 0,
    online: 0,
    offline: 0,
    pendingInstall: 0,
    attention: 0,
    suspended: 0,
    restricted: 0,
    cameraTotal: 0,
    cameraOnline: 0,
    cameraOffline: 0,
    cameraError: 0,
    openAlarms: 0,
    streamHighCpuRiskCameras: 0,
    streamLiveTranscodeLikely: 0,
    streamLiveFailuresLast24h: 0,
    streamOptimizationSafeActions: 0,
    recordingGapSecondsLast24h: 0,
    recordingAttentionCameras: 0,
    maxDiskUsagePercent: 0,
    computeNodesConfigured: 0,
    computeNodesTotal: 0,
  });

  const topAttention = items
    .map((item) => {
      const diskUsagePercent = Number(metricValue(item, 'diskUsagePercent', 0) || 0);
      const cameraIssues = Number(metricValue(item, 'cameraOffline', 0) || 0) + Number(metricValue(item, 'cameraError', 0) || 0);
      const openAlarms = Number(item.metrics?.openAlarms || 0);
      let score = 0;
      if (item.status !== 'ONLINE') score += item.status === 'PENDING_INSTALL' ? 45 : 100;
      if (item.licenseStatus === 'SUSPENDED') score += 90;
      if (item.licenseStatus === 'RESTRICTED') score += 45;
      if (item.metrics?.productionReadiness === 'blocked') score += 80;
      if (item.metrics?.productionReadiness === 'attention') score += 30;
      if (cameraIssues) score += 35;
      if (diskUsagePercent >= 85) score += 30;
      if (openAlarms) score += 10;
      return {
        id: item.id,
        customerName: item.customerName || item.name || item.id,
        status: item.status,
        licenseStatus: item.licenseStatus,
        productionReadiness: item.metrics?.productionReadiness || item.metrics?.status || 'unknown',
        diskUsagePercent,
        cameraIssues,
        openAlarms,
        ageSeconds: item.ageSeconds,
        score,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    onlineThresholdSeconds: ONLINE_THRESHOLD_SECONDS,
    totals,
    topAttention,
  };
}

function supportDiagnostics(item) {
  // Estado do backup, para o painel mostrar sem precisar abrir a lista.
  // A Vibe ficou 4 dias sem cópia e ninguém soube — backup que falha em
  // silêncio é o mesmo que não ter backup.
  const _atraso = avaliarAtrasoDeBackup({
    ultimoBackupEm: item.ultimoBackup?.recebidoEm || null,
    criadaEm: item.createdAt || null,
    agoraMs: Date.now(),
  });
  const publicItem = publicInstallation(item);
  const activeAlerts = (publicItem.alertHistory || []).filter((alert) => alert.status === 'ACTIVE').slice(0, 20);
  return {
    generatedAt: new Date().toISOString(),
    installation: {
      id: publicItem.id,
      customerName: publicItem.customerName,
      status: publicItem.status,
      ageSeconds: publicItem.ageSeconds,
      licenseStatus: publicItem.licenseStatus,
      policyPending: publicItem.policyPending,
      // Cópia de segurança: nível, dias e o texto pronto para o operador.
      // A Vibe ficou 4 dias sem cópia e ninguém soube — backup que falha em
      // silêncio é o mesmo que não ter backup.
      backup: {
        nivel: _atraso.nivel,
        dias: _atraso.dias,
        ultimaEm: item.ultimoBackup ? item.ultimoBackup.recebidoEm : null,
        aviso: explicarAtraso(_atraso, publicItem.id),
      },
      version: publicItem.version,
      launchProfile: publicItem.launchProfile,
      lastHeartbeatAt: publicItem.lastHeartbeatAt,
    },
    readiness: {
      status: publicItem.metrics?.productionReadiness || publicItem.metrics?.status || 'unknown',
      checks: publicItem.metrics?.readiness?.checks ?? null,
      warnings: publicItem.metrics?.readiness?.warnings ?? null,
      failures: publicItem.metrics?.readiness?.failures ?? null,
      lastError: publicItem.metrics?.lastError || null,
    },
    cameras: {
      total: metricValue(publicItem, 'cameraTotal', 0),
      online: metricValue(publicItem, 'cameraOnline', 0),
      offline: metricValue(publicItem, 'cameraOffline', 0),
      error: metricValue(publicItem, 'cameraError', 0),
    },
    storage: publicItem.storage?.disk ? {
      usedBytes: publicItem.storage.disk.usedBytes,
      totalBytes: publicItem.storage.disk.totalBytes,
      usagePercent: publicItem.storage.disk.usagePercent ?? metricValue(publicItem, 'diskUsagePercent', null),
    } : null,
    server: publicItem.server ? {
      hostname: publicItem.server.hostname,
      platform: publicItem.server.platform,
      cpuCount: publicItem.server.cpuCount,
      totalMemoryBytes: publicItem.server.totalMemoryBytes,
      freeMemoryBytes: publicItem.server.freeMemoryBytes,
      loadAverage: publicItem.server.loadAverage,
    } : null,
    alerts: activeAlerts.map((alert) => ({
      level: alert.level,
      code: alert.code,
      message: alert.message,
      firstSeenAt: alert.firstSeenAt,
      lastSeenAt: alert.lastSeenAt,
      occurrences: alert.occurrences,
    })),
    lastHeartbeats: (publicItem.heartbeatHistory || []).slice(-10),
  };
}

// ── Série temporal para o painel ────────────────────────────────────────────
// Formato ESTÁVEL e simples de desenhar: `points` é um array de { t, ...valores }
// com as MESMAS chaves em qualquer resolução/fonte. Quem consome não precisa
// saber se veio do Postgres ou do histórico curto do JSON.
function timeseriesRetention(store) {
  return {
    rawHours: store?.rawRetentionHours ?? timeseries.DEFAULT_RAW_RETENTION_HOURS,
    hourlyDays: store?.hourlyRetentionDays ?? timeseries.DEFAULT_HOURLY_RETENTION_DAYS,
  };
}

async function handleInstallationTimeseries(req, res, db, url, installationId) {
  const item = db.installations[installationId];
  if (!item) {
    await saveDb(db);
    return json(req, res, 404, { error: 'installation_not_found' });
  }
  const range = timeseries.resolveRange({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
  const store = getTimeseries();
  await saveDb(db);

  const series = store && store.enabled
    ? await withTimeseries((s) => s.installationSeries(installationId, { ...range, resolution: url.searchParams.get('resolution') }), 'series')
    : null;

  if (!series) {
    // DEFAULT (sem Postgres) ou falha do banco: o histórico CURTO que já existe
    // hoje dentro do JSON, na mesma forma de ponto. O painel nunca fica sem dado.
    return json(req, res, 200, {
      installationId,
      source: 'json',
      enabled: Boolean(store && store.enabled),
      degraded: Boolean(store && store.enabled),
      ...range,
      resolution: 'raw',
      retention: timeseriesRetention(store),
      points: timeseries.pointsFromHeartbeatHistory(item.heartbeatHistory, range),
      cameras: [],
    });
  }

  const cameras = (await withTimeseries((s) => s.cameraHealth(installationId), 'camera-health')) || [];
  return json(req, res, 200, {
    installationId,
    source: 'postgres',
    enabled: true,
    degraded: false,
    ...series,
    retention: timeseriesRetention(store),
    cameras,
  });
}

async function handleFleetTimeseries(req, res, db, url) {
  const range = timeseries.resolveRange({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
  const bucketSeconds = timeseries.normalizeBucketSeconds(url.searchParams.get('bucket'), 300);
  const store = getTimeseries();
  const installations = Object.entries(db.installations || {});
  await saveDb(db);

  const series = store && store.enabled
    ? await withTimeseries((s) => s.fleetSeries({ ...range, resolution: url.searchParams.get('resolution'), bucketSeconds }), 'fleet-series')
    : null;

  if (!series) {
    const rows = [];
    for (const [id, item] of installations) {
      const points = timeseries.pointsFromHeartbeatHistory(item?.heartbeatHistory, range);
      if (points.length) rows.push(...timeseries.toBucketRows(id, points, bucketSeconds));
    }
    return json(req, res, 200, {
      source: 'json',
      enabled: Boolean(store && store.enabled),
      degraded: Boolean(store && store.enabled),
      ...range,
      resolution: 'raw',
      bucketSeconds,
      retention: timeseriesRetention(store),
      installations: installations.length,
      points: timeseries.foldFleetRows(rows),
    });
  }

  return json(req, res, 200, {
    source: 'postgres',
    enabled: true,
    degraded: false,
    ...series,
    retention: timeseriesRetention(store),
    installations: installations.length,
  });
}

function licenseResponse(item) {
  const status = item.licenseStatus || LICENSE_ACTIVE;
  const restrictions = {
    adminAccess: true,
    cloudSupport: status !== 'SUSPENDED',
    updates: status === 'ACTIVE' || status === 'GRACE',
    addCameras: status !== 'RESTRICTED' && status !== 'SUSPENDED',
    aiAdvanced: status === 'ACTIVE' || status === 'GRACE',
    exports: true,
    localLive: status !== 'SUSPENDED',
    localPlayback: true,
    localRecording: status !== 'SUSPENDED',
  };
  // Storage em nuvem provisionado pelo painel. Desce no MESMO canal da política
  // de IA — a instalação já sabe consumir a resposta do heartbeat, então não é
  // preciso abrir porta nela nem inverter o sentido da conexão (o que
  // funcionaria mal atrás de NAT, que é a maioria das instalações).
  //
  // Instalação SUSPENSA não recebe credencial: além de não gravar localmente,
  // não deve continuar consumindo bucket de um contrato interrompido.
  const cloudStorage = status === 'SUSPENDED' ? null : buildCloudStoragePayload(item.cloudStorage);

  return {
    licenseStatus: status,
    licenseMessage: item.licenseMessage || null,
    // Teto de câmeras contratado. null = sem teto; a instalação trata assim.
    maxCameras: tetoParaHeartbeat(item.maxCameras),
    maxUsers: tetoParaHeartbeat(item.maxUsers),
    maxRetentionDays: tetoParaHeartbeat(item.maxRetentionDays),
    // Túnel até a rede de câmeras do cliente. null = sem VPN configurada;
    // perfil vazio faria a instalação concluir que precisa desmontar algo.
    vpn: perfilParaHeartbeat(item.vpn),
    // A política de IA do painel restringe ABAIXO do teto da licença (nunca acima).
    restrictions: applyAiPolicyToRestrictions(restrictions, item.aiPolicy),
    cloudStorage,
    cloudStorageState: cloudStorageState(item, status),
    // Identidade visual desejada. A instalação a aplica pelo mesmo canal
    // autenticado do heartbeat; a Central nunca precisa conhecer a senha de um
    // administrador local nem alcançar uma porta atrás de NAT/CGNAT.
    branding: item.branding || null,
    // Confirma o snapshot de marca reportado pela instalação. Sem este ACK o
    // cliente continuaria enviando um logo base64 em todo heartbeat; com ele,
    // só reenvia quando a identidade local realmente mudar.
    brandingAcceptedHash: item.reportedBrandingHash || null,
    // Storages EXCLUÍDOS aqui. Excluir na Central quer dizer "este destino
    // acabou e o conteúdo dele já foi embora" — a instalação usa esta lista
    // para expurgar do banco tudo que apontava para ele. É LISTA, e não um
    // aviso único, porque a instalação pode passar dias offline e perderia a
    // notificação de uma exclusão feita nesse meio-tempo.
    cloudStorageRemovals: Array.isArray(item.cloudStorageRemovals) ? item.cloudStorageRemovals : [],
    // Revisão DESEJADA. A instalação devolve a que aplicou no próximo heartbeat.
    configRevision: Number(item.configRevision || 0) || 0,
    reactivationArchive: item.reactivationRestore?.state === 'REQUESTED'
      ? { action: 'RESTORE', requestId: item.reactivationRestore.requestId }
      : item.reactivationArchive?.state === 'REQUESTED'
        ? { action: 'CREATE', requestId: item.reactivationArchive.requestId }
        : null,
  };
}

async function handleUploadReactivationArchive(req, res) {
  const installationId = String(req.headers['x-drac-installation-id'] || '').trim();
  const licenseKey = String(req.headers['x-drac-license-key'] || '').trim();
  const db = await loadDb();
  const item = db.installations[installationId];
  if (!item || !licenseKey || !timingSafeTextEquals(item.licenseKey || '', licenseKey)) {
    return json(req, res, 403, { error: 'invalid_installation_credentials' });
  }
  const body = await readBody(req);
  const requestId = String(body.requestId || '').trim();
  const pending = item.reactivationArchive;
  if (!pending || pending.state !== 'REQUESTED' || !requestId || requestId !== pending.requestId) {
    return json(req, res, 409, { error: 'archive_request_not_active' });
  }
  try {
    const metadata = await reactivationArchiveStore().write(installationId, requestId, body.snapshot, pending.expiresAt);
    item.reactivationArchive = metadata;
    item.updatedAt = new Date().toISOString();
    addAuditEvent(db, req, { type: 'installation.archive_created', actor: installationId, result: 'accepted', installationId });
    await saveDb(db);
    return json(req, res, 201, { ok: true, archive: metadata });
  } catch (error) {
    return json(req, res, 503, { error: 'archive_unavailable', message: error instanceof Error ? error.message : 'Falha ao cifrar arquivo.' });
  }
}

async function handleDownloadReactivationArchive(req, res, requestId) {
  const installationId = String(req.headers['x-drac-installation-id'] || '').trim();
  const licenseKey = String(req.headers['x-drac-license-key'] || '').trim();
  const db = await loadDb();
  const item = db.installations[installationId];
  if (!item || !licenseKey || !timingSafeTextEquals(item.licenseKey || '', licenseKey)) {
    return json(req, res, 403, { error: 'invalid_installation_credentials' });
  }
  if (item.reactivationArchive?.state !== 'AVAILABLE'
      || item.reactivationRestore?.state !== 'REQUESTED'
      || requestId !== item.reactivationRestore.requestId) {
    return json(req, res, 409, { error: 'restore_request_not_active' });
  }
  try {
    const payload = await reactivationArchiveStore().read(installationId);
    if (payload.installationId !== installationId) return json(req, res, 409, { error: 'archive_installation_mismatch' });
    return json(req, res, 200, { ok: true, requestId, snapshot: payload.snapshot });
  } catch (error) {
    return json(req, res, 503, { error: 'archive_unavailable', message: error instanceof Error ? error.message : 'Falha ao abrir arquivo.' });
  }
}

async function handleConfirmReactivationRestore(req, res, requestId) {
  const installationId = String(req.headers['x-drac-installation-id'] || '').trim();
  const licenseKey = String(req.headers['x-drac-license-key'] || '').trim();
  const db = await loadDb();
  const item = db.installations[installationId];
  if (!item || !licenseKey || !timingSafeTextEquals(item.licenseKey || '', licenseKey)) {
    return json(req, res, 403, { error: 'invalid_installation_credentials' });
  }
  if (item.reactivationRestore?.state !== 'REQUESTED' || requestId !== item.reactivationRestore.requestId) {
    return json(req, res, 409, { error: 'restore_request_not_active' });
  }
  const body = await readBody(req);
  const status = String(body.status || '').toUpperCase();
  if (!['RESTORED', 'PRESERVED_EXISTING'].includes(status)) return json(req, res, 400, { error: 'invalid_restore_status' });
  const now = new Date().toISOString();
  item.reactivationRestore = {
    ...item.reactivationRestore,
    state: status,
    completedAt: now,
    summary: body.summary && typeof body.summary === 'object' ? body.summary : null,
  };
  item.updatedAt = now;
  addAuditEvent(db, req, {
    type: 'installation.archive_restore_completed', actor: installationId, result: 'accepted', installationId, status,
  });
  await saveDb(db);
  return json(req, res, 200, { ok: true, restore: item.reactivationRestore });
}

async function handleRequestReactivationArchive(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  if (!process.env.DRAC_CENTRAL_ARCHIVE_KEY || String(process.env.DRAC_CENTRAL_ARCHIVE_KEY).trim().length < 32) {
    return json(req, res, 503, { error: 'archive_key_not_configured', message: 'Configure a chave separada dos arquivos de reativação antes de cancelar.' });
  }
  const now = new Date();
  const requestId = crypto.randomUUID();
  item.reactivationArchive = {
    state: 'REQUESTED', requestId, requestedAt: now.toISOString(),
    expiresAt: expiresAfterMonths(now, REACTIVATION_RETENTION_MONTHS),
  };
  const previousStatus = item.licenseStatus || LICENSE_ACTIVE;
  item.licenseStatus = 'SUSPENDED';
  item.licenseMessage = 'Contrato cancelado; aguardando arquivo final de reativação.';
  item.updatedAt = now.toISOString();
  item.configRevision = Number(item.configRevision || 0) + 1;
  const history = Array.isArray(item.licenseHistory) ? item.licenseHistory : [];
  history.push({ at: now.toISOString(), from: previousStatus, to: 'SUSPENDED', by: actor.email, message: item.licenseMessage });
  item.licenseHistory = history.slice(-30);
  addAuditEvent(db, req, { type: 'installation.archive_requested', actor: actor.email, result: 'accepted', installationId, expiresAt: item.reactivationArchive.expiresAt });
  await saveDb(db);
  return json(req, res, 202, { ok: true, archive: item.reactivationArchive });
}

async function handleDeleteReactivationArchive(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  try { await reactivationArchiveStore().delete(installationId); } catch (error) {
    return json(req, res, 503, { error: 'archive_delete_failed', message: error instanceof Error ? error.message : 'Falha ao excluir arquivo.' });
  }
  item.reactivationArchive = { state: 'DELETED', deletedAt: new Date().toISOString(), deletedBy: actor.email };
  addAuditEvent(db, req, { type: 'installation.archive_deleted', actor: actor.email, result: 'accepted', installationId });
  await saveDb(db);
  return json(req, res, 200, { ok: true, archive: item.reactivationArchive });
}

async function handleReactivateInstallation(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  if (item.reactivationArchive?.state !== 'AVAILABLE') return json(req, res, 409, { error: 'archive_not_available' });
  const now = new Date().toISOString();
  const previousStatus = item.licenseStatus || 'SUSPENDED';
  item.licenseStatus = LICENSE_ACTIVE;
  item.licenseMessage = 'Instalação reativada; confirme novamente as credenciais das câmeras.';
  item.configRevision = Number(item.configRevision || 0) + 1;
  item.updatedAt = now;
  item.reactivationArchive = { ...item.reactivationArchive, lastReactivatedAt: now, lastReactivatedBy: actor.email };
  item.reactivationRestore = {
    state: 'REQUESTED',
    requestId: crypto.randomUUID(),
    requestedAt: now,
    requestedBy: actor.email,
  };
  const history = Array.isArray(item.licenseHistory) ? item.licenseHistory : [];
  history.push({ at: now, from: previousStatus, to: LICENSE_ACTIVE, by: actor.email, message: item.licenseMessage });
  item.licenseHistory = history.slice(-30);
  addAuditEvent(db, req, { type: 'installation.archive_reactivated', actor: actor.email, result: 'accepted', installationId });
  await saveDb(db);
  return json(req, res, 200, { ok: true, installation: publicInstallation(item) });
}

async function expireReactivationArchives() {
  const db = await loadDb();
  let changed = false;
  const now = new Date();
  for (const [installationId, item] of Object.entries(db.installations || {})) {
    const archive = item?.reactivationArchive;
    if (!archive || archive.state !== 'AVAILABLE' || !archive.expiresAt || new Date(archive.expiresAt) > now) continue;
    await reactivationArchiveStore().delete(installationId).catch(() => undefined);
    item.reactivationArchive = {
      ...archive,
      state: 'EXPIRED',
      expiredAt: now.toISOString(),
      // checksum e tamanho permanecem como certificado do que foi eliminado.
    };
    addAuditEvent(db, { headers: {}, socket: {} }, {
      type: 'installation.archive_expired', actor: 'system', result: 'accepted', installationId,
    });
    changed = true;
  }
  if (changed) await saveDb(db);
  return changed;
}

function startReactivationArchiveMaintenance() {
  const run = () => runSerialized(expireReactivationArchives).catch((error) => {
    console.error('[central] falha ao expirar arquivos de reativação:', error.message);
  });
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  run();
  return timer;
}

/**
 * POR QUE o storage não desceu — três motivos que exigem reações OPOSTAS.
 *
 * Até aqui os três colapsavam em `cloudStorage: null`, e a instalação não tinha
 * como distinguir "o operador desligou o envio" de "o storage foi EXCLUÍDO".
 * São coisas diferentes:
 *
 *   configured — desceu credencial; é o destino das gravações novas.
 *   disabled   — existe storage, mas o envio está desligado (ou a licença está
 *                suspensa). É uma PAUSA: nada sobe, e nenhum outro storage deve
 *                assumir o lugar, senão desligar não desligaria nada.
 *   absent     — não há storage nenhum cadastrado. O destino sumiu de vez, e a
 *                instalação deve seguir com outro storage que ainda tenha, ou
 *                ficar só no disco local.
 */
function cloudStorageState(item, status) {
  const c = normalizeCloudStorage(item.cloudStorage);
  const cadastrado = Boolean(c.endpoint || c.bucket || c.accessKeyId || c.secretAccessKeyEncrypted);
  if (!cadastrado) return 'absent';
  if (status === 'SUSPENDED' || !c.enabled) return 'disabled';
  // Cadastrado e habilitado, mas incompleto (falta bucket, credencial ilegível):
  // é pausa, não exclusão — o operador está no meio de configurar.
  return buildCloudStoragePayload(c) ? 'configured' : 'disabled';
}

/**
 * MATRÍCULA de instalação nova, sem precisar provisionar pela tela antes.
 *
 * Fecha o buraco de 24/08/2026: o instalador tentava "registrar" mandando um
 * heartbeat, mas o heartbeat exige que a instalação já exista — então tomava
 * 403, avisava e seguia. Toda instalação feita direto pelo script nascia órfã,
 * e com a licença que vence sozinha isso viraria suspensão em 15 dias.
 *
 * A decisão de permitir mora em `matricula.js`, testada sem rede nem banco.
 */
async function handleEnroll(req, res) {
  const body = await readBody(req);
  const tokenApresentado = String(req.headers['x-drac-enrollment-token'] || '').trim();
  const installationId = slugify(String(body.installationId || body.customerName || '').trim());
  const customerName = String(body.customerName || '').trim();
  const chaveApresentada = String(body.licenseKey || '').trim();

  if (!installationId || !customerName) {
    return json(req, res, 400, { error: 'missing_installation_or_customer' });
  }

  const db = await loadDb();
  const existente = db.installations[installationId] || null;
  const d = decidirMatricula({
    tokenApresentado,
    tokenConfigurado: ENROLLMENT_TOKEN,
    existente,
    chaveApresentada,
    comparar: timingSafeTextEquals,
  });

  if (!d.permitido) {
    addAuditEvent(db, req, {
      type: 'agent.enroll_denied',
      actor: installationId,
      result: 'denied',
      reason: d.motivo,
    });
    await saveDb(db);
    return json(req, res, d.http, { error: d.motivo });
  }

  const agora = new Date().toISOString();
  // A chave PROPOSTA pela instalação é aceita: ela já a gravou no próprio
  // `.env` antes de subir os containers, e devolver outra obrigaria o
  // instalador a reescrever configuração e reiniciar tudo de novo.
  const licenseKey = (existente && existente.licenseKey)
    || chaveApresentada
    || `drac-${crypto.randomBytes(16).toString('hex')}`;

  const item = {
    ...(existente || {}),
    id: installationId,
    name: installationId,
    customerName,
    licenseKey,
    licenseStatus: (existente && existente.licenseStatus) || LICENSE_ACTIVE,
    serverAddress: String(body.serverAddress || (existente && existente.serverAddress) || '').trim() || null,
    cameraAllowedCidrs: String(body.cameraAllowedCidrs || (existente && existente.cameraAllowedCidrs) || '').trim() || null,
    createdAt: (existente && existente.createdAt) || agora,
    updatedAt: agora,
  };
  db.installations[installationId] = item;
  addAuditEvent(db, req, {
    type: 'agent.enrolled',
    actor: installationId,
    result: 'accepted',
    reason: d.motivo,
    installationId,
  });
  await saveDb(db);
  return json(req, res, d.http, { installationId, licenseKey, motivo: d.motivo });
}

async function handleHeartbeat(req, res) {
  const installationId = String(req.headers['x-drac-installation-id'] || '').trim();
  const licenseKey = String(req.headers['x-drac-license-key'] || '').trim();
  if (!installationId || !licenseKey) {
    return json(req, res, 401, { error: 'missing_installation_or_license' });
  }

  const body = await readBody(req);
  const db = await loadDb();
  const existing = db.installations[installationId];
  // A instalação TEM de existir: handleProvision a cria (com licenseKey) antes de o
  // cliente dar o primeiro heartbeat. Antes, um id desconhecido caía em `{}` e o check
  // de licença era pulado (`existing.licenseKey` undefined) → QUALQUER UM na internet
  // registrava instalações e injetava `metrics`/`server` arbitrários, que o painel do
  // dono renderiza (era o vetor do XSS armazenado) — além de encher o installations.json.
  if (!existing) {
    addAuditEvent(db, req, { type: 'agent.heartbeat_denied', actor: installationId, result: 'denied' });
    await saveDb(db);
    return json(req, res, 403, { error: 'unknown_installation' });
  }
  const expectedKey = existing.licenseKey || licenseKey;
  // timing-safe, como já era em handleAgentStatus/handleInstall.
  if (existing.licenseKey && !timingSafeTextEquals(existing.licenseKey, licenseKey)) {
    addAuditEvent(db, req, { type: 'agent.heartbeat_denied', actor: installationId, result: 'denied' });
    await saveDb(db);
    return json(req, res, 403, { error: 'invalid_license_key' });
  }

  const now = new Date().toISOString();
  const metrics = body.summary || body.metrics || {};

  // A instalação pode estar atrás de NAT e não expor /settings/branding para a
  // Central (caso real: D-GUARDIAN). Ela reporta a marca pelo canal de saída
  // autenticado somente quando o hash muda. Validamos antes de persistir para
  // não transformar o heartbeat em armazenamento arbitrário de base64.
  let reportedBranding = existing.reportedBranding || null;
  let reportedBrandingHash = existing.reportedBrandingHash || null;
  if (body.brandingState != null) {
    const checked = validateManagedBranding(body.brandingState, existing.customerName || existing.name || installationId);
    if (checked.ok) {
      reportedBranding = checked.value;
      reportedBrandingHash = crypto.createHash('sha256').update(JSON.stringify(checked.value)).digest('hex');
    }
  }

  // ── CONFIRMAÇÃO DE APLICAÇÃO ────────────────────────────────────────────────
  // A instalação reporta o que de fato aplicou. É isto que substitui a
  // inferência por data: antes, `policyPending` só comparava `updatedAt` com o
  // último heartbeat, o que prova apenas que a instalação esteve ONLINE depois
  // da mudança — não que ela aplicou. Uma instalação antiga que ignorasse um
  // campo desconhecido saía da lista de pendências sem ter aplicado nada.
  const configState = body.configState && typeof body.configState === 'object' ? body.configState : null;
  if (configState) {
    existing.appliedConfigRevision = Number(configState.appliedRevision || 0) || 0;
    existing.configApplyStatus = String(configState.applyStatus || 'UNKNOWN');
    existing.configApplyError = configState.applyError ? String(configState.applyError).slice(0, 500) : null;
    existing.configApplyAt = now;
    // O que ESTA versão da instalação entende. Sem isto, a Central marcaria
    // como "pendente para sempre" uma configuração que a instalação sequer
    // conhece — e o operador ficaria tentando reaplicar algo impossível.
    existing.supportedConfigKeys = Array.isArray(configState.supports)
      ? configState.supports.map((k) => String(k)).slice(0, 50)
      : null;
  } else {
    // Instalação ANTIGA (não reporta estado): registramos isso explicitamente
    // em vez de fingir que aplicou.
    existing.configApplyStatus = 'UNSUPPORTED';
    existing.supportedConfigKeys = null;
  }
  const receivedAlerts = Array.isArray(metrics.alerts) ? metrics.alerts : Array.isArray(body.alerts) ? body.alerts : [];
  const alerts = receivedAlerts.slice(0, 100).map(alertas.normalizarAlertaOperacional);
  const memoryUsagePercent = body.server?.totalMemoryBytes
    ? Math.round(((Number(body.server.totalMemoryBytes) - Number(body.server.freeMemoryBytes || 0)) / Number(body.server.totalMemoryBytes)) * 100)
    : null;
  const heartbeatHistory = Array.isArray(existing.heartbeatHistory) ? existing.heartbeatHistory : [];
  heartbeatHistory.push({
    at: now,
    status: metrics.status || 'ok',
    cameraTotal: Number(metricValue({ metrics }, 'cameraTotal', 0)),
    cameraOnline: Number(metricValue({ metrics }, 'cameraOnline', 0)),
    cameraOffline: Number(metricValue({ metrics }, 'cameraOffline', 0)),
    cameraError: Number(metricValue({ metrics }, 'cameraError', 0)),
    openAlarms: Number(metrics.openAlarms || 0),
    diskUsagePercent: metrics.diskUsagePercent ?? metrics.disk?.usagePercent ?? null,
    memoryUsagePercent,
    load1: Array.isArray(body.server?.loadAverage) ? body.server.loadAverage[0] ?? null : null,
    recordingCount: Number(metrics.recordingCount || 0),
    activeRecordingCount: Number(metrics.activeRecordingCount || 0),
    streamHighCpuRiskCameras: Number(metrics.streamHighCpuRiskCameras || 0),
    streamLiveTranscodeLikely: Number(metrics.streamLiveTranscodeLikely || 0),
    streamLiveFailuresLast24h: Number(metrics.streamLiveFailuresLast24h || 0),
    streamMediaMtxReaders: Number(metrics.streamMediaMtxReaders || 0),
    streamOptimizationSafeActions: Number(metrics.streamOptimizationSafeActions || 0),
    recordingGapSecondsLast24h: Number(metrics.recordingGapSecondsLast24h || 0),
    recordingAttentionCameras: Number(metrics.recordingAttentionCameras || 0),
    activeUsers: Number(metrics.activeUsers || 0),
  });
  while (heartbeatHistory.length > HEARTBEAT_HISTORY_LIMIT) heartbeatHistory.shift();
  const { history: alertHistory, novos: alertasNovos, resolvidos: alertasResolvidos } = updateAlertHistory(existing, alerts, now);
  const item = {
    ...existing,
    id: installationId,
    licenseKey: expectedKey,
    // IP de onde o cliente envia heartbeat — usado p/ derivar o servidor da API
    // ao gerar o app automaticamente, quando não há endereço cadastrado.
    observedAddress: clientIp(req) || existing.observedAddress || null,
    reportedApiUrl: body.installation?.apiUrl || body.apiUrl || existing.reportedApiUrl || null,
    name: body.installation?.name || existing.name || installationId,
    customerName: body.installation?.customerName || existing.customerName || null,
    launchProfile: body.installation?.launchProfile || metrics.launchProfile || existing.launchProfile || null,
    version: body.installation?.version || existing.version || null,
    lastHeartbeatAt: now,
    updatedAt: now,
    metrics,
    alerts,
    alertHistory,
    server: body.server || existing.server || null,
    storage: body.storage || existing.storage || null,
    production: body.production || existing.production || null,
    reportedBranding,
    reportedBrandingHash,
    heartbeatHistory,
    lastPayloadHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    licenseStatus: existing.licenseStatus || LICENSE_ACTIVE,
    licenseMessage: existing.licenseMessage || null,
  };
  db.installations[installationId] = item;
  await saveDb(db);

  // ── AVISAR QUEM PRECISA SABER ─────────────────────────────────────────────
  //
  // Até aqui o alerta virava histórico e parava na tela. Quem não estivesse
  // com o painel aberto não ficava sabendo — e o painel não fica aberto de
  // madrugada, que é quando a maioria das quedas acontece.
  //
  // DEPOIS do saveDb e SEM await: o heartbeat responde em milissegundos e o
  // envio (SMTP e HTTPS externos) corre por fora. Segurar a resposta faria a
  // instalação achar que a Central caiu por causa de um servidor de e-mail
  // lento — trocaria um problema de aviso por um de monitoramento.
  despacharAlertasDaInstalacao(item, alertasNovos, alertasResolvidos);

  // Série temporal: o JSON continua guardando só as últimas ~100 amostras (o
  // arquivo não aguenta mais que isso); o histórico LONGO vai para o Postgres,
  // quando houver. Sem Postgres isto é um retorno imediato.
  const cameraRaw = heartbeatCameraRaw(body);
  const cameraHealth = cameraRaw === null ? null : timeseries.parseCameraHealth(cameraRaw);
  await withTimeseries(
    (store) => store.recordHeartbeat(installationId, {
      sample: timeseries.buildSample({
        at: now,
        metrics,
        alerts,
        cameraHealth,
        cameraTotals: cameraRaw,
        storage: body.storage,
      }),
      cameras: cameraHealth,
    }),
    'heartbeat',
  );
  return json(req, res, 200, {
    accepted: true,
    serverTime: now,
    ...licenseResponse(item),
    // A versão aprovada desce pelo canal que JÁ existe. Abrir porta na
    // instalação para empurrar atualização funcionaria mal atrás de NAT, que é
    // a maioria delas — aqui quem pergunta é sempre a instalação.
    release: releases.releaseParaInstalacao(releaseAtual(db), item),
  });
}

// Push direto FCM: a instalação autentica-se com a mesma identidade já usada
// pelo heartbeat. Ela nunca recebe a conta de serviço Firebase; a Central é o
// único ponto que possui a credencial e envia somente para tokens fornecidos
// pela própria instalação autenticada.
async function handleFcmPush(req, res) {
  const installationId = String(req.headers['x-drac-installation-id'] || '').trim();
  const licenseKey = String(req.headers['x-drac-license-key'] || '').trim();
  if (!installationId || !licenseKey) return json(req, res, 401, { error: 'missing_installation_or_license' });

  const db = await loadDb();
  const installation = db.installations[installationId];
  if (!installation || !installation.licenseKey || !timingSafeTextEquals(installation.licenseKey, licenseKey)) {
    addAuditEvent(db, req, { type: 'agent.fcm_push_denied', actor: installationId || 'unknown', result: 'denied' });
    await saveDb(db);
    return json(req, res, 403, { error: 'invalid_installation_identity' });
  }

  const body = await readBody(req);
  const tokens = Array.isArray(body.tokens) ? body.tokens.map((value) => String(value || '').trim()) : [];
  if (!tokens.length || tokens.length > firebaseMessaging.MAX_TOKENS || tokens.some((token) => !firebaseMessaging.TOKEN_RE.test(token))) {
    return json(req, res, 400, { error: 'invalid_fcm_tokens' });
  }
  const message = body.message && typeof body.message === 'object' ? body.message : null;
  if (!message) return json(req, res, 400, { error: 'invalid_fcm_message' });

  try {
    const result = await firebaseMessaging.sendToTokens(tokens, message);
    addAuditEvent(db, req, {
      type: 'agent.fcm_push_sent', actor: installationId, result: 'accepted', installationId,
      accepted: result.accepted, invalidTokens: result.invalidTokens.length,
    });
    await saveDb(db);
    return json(req, res, 200, result);
  } catch (error) {
    const code = String(error?.code || 'fcm_send_failed');
    addAuditEvent(db, req, { type: 'agent.fcm_push_failed', actor: installationId, result: 'failed', installationId, reason: code });
    await saveDb(db);
    return json(req, res, Number(error?.status) || 502, { error: code, message: 'Não foi possível entregar a notificação agora.' });
  }
}

async function handleAgentStatus(req, res) {
  const installationId = String(req.headers['x-drac-installation-id'] || '').trim();
  const licenseKey = String(req.headers['x-drac-license-key'] || '').trim();
  if (!installationId || !licenseKey) {
    return json(req, res, 401, { error: 'missing_installation_or_license' });
  }

  const db = await loadDb();
  const item = db.installations[installationId];
  if (!item) {
    return json(req, res, 404, { error: 'installation_not_found' });
  }
  if (!timingSafeTextEquals(item.licenseKey || '', licenseKey)) {
    addAuditEvent(db, req, { type: 'agent.status_denied', actor: installationId, result: 'denied' });
    await saveDb(db);
    return json(req, res, 403, { error: 'invalid_license_key' });
  }

  const lastHeartbeatAt = item.lastHeartbeatAt || null;
  const ageSeconds = lastHeartbeatAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastHeartbeatAt).getTime()) / 1000))
    : null;
  return json(req, res, 200, {
    accepted: true,
    installationId,
    customerName: item.customerName || null,
    lastHeartbeatAt,
    heartbeatAgeSeconds: ageSeconds,
    online: ageSeconds !== null && ageSeconds <= ONLINE_THRESHOLD_SECONDS,
    ...licenseResponse(item),
    // Também aqui, e não só no heartbeat: o script de atualização precisa de um
    // GET simples para perguntar "qual é a versão aprovada e eu estou nela?".
    release: releases.releaseParaInstalacao(releaseAtual(db), item),
  });
}

// ── FILA DE OPERAÇÕES REMOTAS ──────────────────────────────────────────────
// A instalação busca a ordem; a Central não inicia conexão de volta. Além de
// funcionar em NAT/CGNAT, isto mantém Docker e SSH fora da superfície pública.
async function handleClaimOperation(req, res) {
  const db = await loadDb();
  const auth = authenticateInstallationRequest(req, db);
  if (auth.error) return json(req, res, auth.http, { error: auth.error });
  const leaseToken = crypto.randomBytes(24).toString('hex');
  auth.installation.operationsAgentLastSeenAt = new Date().toISOString();
  const operation = operations.claim(auth.installation, { leaseToken });
  if (operation) {
    auth.installation.updatedAt = new Date().toISOString();
    addAuditEvent(db, req, {
      type: 'operation.claimed', actor: auth.installationId, result: 'accepted', installationId: auth.installationId,
      action: operation.action, operationId: operation.id,
    });
  }
  await saveDb(db);
  return json(req, res, 200, {
    operation: operation ? {
      id: operation.id, action: operation.action, targetCommit: operation.targetCommit || null,
      leaseToken, expiresAt: operation.expiresAt,
    } : null,
  });
}

async function handleOperationResult(req, res, operationId) {
  const db = await loadDb();
  const auth = authenticateInstallationRequest(req, db);
  if (auth.error) return json(req, res, auth.http, { error: auth.error });
  const body = await readBody(req);
  const outcome = operations.finish(auth.installation, operationId, {
    leaseToken: body.leaseToken,
    status: String(body.status || ''),
    result: body.result,
    error: body.error,
  });
  if (!outcome.ok) return json(req, res, 409, { error: outcome.error });
  auth.installation.updatedAt = new Date().toISOString();
  addAuditEvent(db, req, {
    type: 'operation.finished', actor: auth.installationId,
    result: outcome.operation.status === operations.SUCCEEDED ? 'accepted' : 'failed',
    installationId: auth.installationId, action: outcome.operation.action, operationId,
  });
  await saveDb(db);
  return json(req, res, 200, { ok: true, operation: operations.publicOperation(outcome.operation) });
}

async function handleQueueOperation(req, res, db, actor, installationId) {
  const installation = db.installations[installationId];
  if (!installation) return json(req, res, 404, { error: 'installation_not_found' });
  const body = await readBody(req);
  const action = operations.normalizeAction(body.action);
  if (!action) return json(req, res, 400, { error: 'invalid_operation', message: 'Ação operacional inválida.' });
  const info = operations.actionInfo(action);
  // Confirmação explícita na API, não só na interface: evita automação ou aba
  // antiga reiniciar mídia/Docker por engano.
  if (String(body.confirmation || '') !== action) {
    return json(req, res, 400, { error: 'operation_confirmation_required', message: 'Confirmação da ação não confere.' });
  }
  const release = releaseAtual(db);
  if (action === 'update' && !release?.commit) {
    return json(req, res, 409, { error: 'no_approved_release', message: 'Não há uma versão aprovada para atualizar.' });
  }
  operations.expireTimedOut(installation);
  const queued = operations.enqueue(installation, {
    id: crypto.randomUUID(), action, requestedBy: actor.email,
    targetCommit: action === 'update' ? release.commit : null,
  });
  if (!queued.ok) {
    return json(req, res, 409, {
      error: queued.error,
      message: 'Já existe uma operação aguardando ou em execução nesta instalação. Aguarde o resultado antes de iniciar outra.',
    });
  }
  installation.updatedAt = new Date().toISOString();
  addAuditEvent(db, req, {
    type: 'operation.queued', actor: actor.email, result: 'accepted', installationId,
    action, operationId: queued.operation.id, critical: Boolean(info?.critical),
  });
  await saveDb(db);
  return json(req, res, 202, { operation: operations.publicOperation(queued.operation) });
}

// ── PROMOVER UMA VERSÃO PARA A FROTA ────────────────────────────────────────
//
// Só chega aqui o que já passou pelo gate: instalação limpa numa máquina
// virgem MAIS a bateria rodada contra a matriz. Quem monta essa evidência é
// `scripts/promover-release.sh`, que roda os dois e só então chama esta rota.
//
// Promover à mão, sem evidência, é recusado de propósito: foi a ausência
// exatamente disto que fez a primeira instalação de cliente virar uma
// sequência de consertos na frente do cliente.
async function handlePromoverRelease(req, res, db, actor) {
  const body = await readBody(req);
  const historico = Array.isArray(db.releaseHistorico) ? db.releaseHistorico : [];

  const resultado = releases.validarPromocao(
    { ...body, promovidoPor: actor?.email || null },
    { historico, permitirSemGate: body?.rollback === true },
  );
  if (!resultado.ok) {
    return json(req, res, 400, {
      error: resultado.erro,
      message: MENSAGENS_PROMOCAO[resultado.erro] || 'Pedido de promoção inválido.',
    });
  }

  db.release = resultado.release;
  db.releaseHistorico = releases.registrarNoHistorico(historico, resultado.release);
  await saveDb(db);

  return json(req, res, 200, {
    atual: db.release,
    frota: releases.resumoDaFrota(db.installations, db.release),
  });
}

const MENSAGENS_PROMOCAO = Object.freeze({
  commit_invalido: 'Informe o commit completo (40 caracteres). Commit curto pode ficar ambíguo, e branch se move.',
  gate_ausente: 'Sem evidência de teste. Rode scripts/promover-release.sh, que executa o gate e promove.',
  gate_instalacao_limpa_ausente: 'Falta o gate de instalação limpa (máquina virgem).',
  gate_matriz_ausente: 'Falta a verificação na matriz. Instalar do zero não prova que roda com dados reais.',
  gate_sem_data_valida: 'A evidência de teste veio sem data válida.',
  repositorio_invalido: 'O repositório precisa ser HTTPS e sem credencial na URL.',
});

async function handleProvision(req, res, db, actor) {
  const body = await readBody(req);
  const customerName = String(body.customerName || '').trim();
  const requestedId = String(body.installationId || '').trim();
  const serverAddress = String(body.serverAddress || '').trim();
  const notes = String(body.notes || '').trim();
  // Redes das câmeras (CIDR, separadas por vírgula). Opcional: sem elas o
  // instalador pergunta no servidor, como antes.
  const cameraAllowedCidrs = String(body.cameraAllowedCidrs || '').trim();

  if (!customerName) return json(req, res, 400, { error: 'missing_customer_name', message: 'Informe o nome do cliente.' });

  const installationId = slugify(requestedId || customerName);
  const existing = db.installations[installationId];
  if (existing?.lastHeartbeatAt) {
    return json(req, res, 409, {
      error: 'installation_already_active',
      message: 'Esta instalação já recebeu heartbeat. Use outro código ou edite o cliente existente.',
    });
  }

  const now = new Date().toISOString();
  const licenseKey = existing?.licenseKey || `drac-${crypto.randomBytes(16).toString('hex')}`;
  const centralUrl = publicBaseUrl(req);

  const item = {
    ...existing,
    id: installationId,
    name: installationId,
    customerName,
    licenseKey,
    licenseStatus: existing?.licenseStatus || LICENSE_ACTIVE,
    licenseMessage: existing?.licenseMessage || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    provisionedAt: now,
    provisionedBy: actor.email,
    provisionedServerAddress: serverAddress || null,
    provisionNotes: notes || null,
    cameraAllowedCidrs: cameraAllowedCidrs || existing?.cameraAllowedCidrs || null,
    metrics: existing?.metrics || {},
    alerts: existing?.alerts || [],
    alertHistory: Array.isArray(existing?.alertHistory) ? existing.alertHistory : [],
    heartbeatHistory: Array.isArray(existing?.heartbeatHistory) ? existing.heartbeatHistory : [],
    licenseHistory: Array.isArray(existing?.licenseHistory) ? existing.licenseHistory : [],
  };
  let installer;
  try {
    // Reprovisionar é uma nova aprovação: captura o artefato configurado agora,
    // persiste o vínculo commit+URL+hash e invalida qualquer comando anterior.
    const installerToken = refreshInstallerGrant(item, {
      release: releaseAtual(db),
      forceArtifact: true,
      forceToken: true,
    });
    installer = buildInstallerResponse(item, centralUrl, installerToken);
  } catch (error) {
    if (error instanceof InstallerConfigurationError) {
      return installerConfigurationResponse(req, res);
    }
    throw error;
  }
  item.lastInstallerCommandHash = crypto.createHash('sha256').update(installer.installCommand).digest('hex');
  db.installations[installationId] = item;
  addAuditEvent(db, req, {
    type: existing ? 'installation.provision_regenerated' : 'installation.provision_created',
    actor: actor.email,
    result: 'accepted',
    installationId,
    installerArtifactId: item.installerArtifact.id,
    installerSha256: item.installerArtifact.sha256,
    installerTokenExpiresAt: item.installerTokenExpiresAt,
    installerTokenRemainingDownloads: item.installerTokenRemainingDownloads,
  });
  await saveDb(db);

  return json(req, res, 201, {
    installation: publicInstallation(item, releaseAtual(db)),
    ...installer,
  });
}

async function handleGetInstallerCommand(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const centralUrl = publicBaseUrl(req);
  let installer;
  try {
    // Comandos novos para registros legados recebem o artefato aprovado atual.
    // Registros já vinculados preservam o mesmo artefato. Cada nova consulta
    // administrativa rotaciona o token, invalidando o comando anterior.
    const installerToken = refreshInstallerGrant(item, { forceToken: true, release: releaseAtual(db) });
    installer = buildInstallerResponse(item, centralUrl, installerToken);
  } catch (error) {
    if (error instanceof InstallerConfigurationError) {
      return installerConfigurationResponse(req, res);
    }
    throw error;
  }
  item.updatedAt = new Date().toISOString();
  addAuditEvent(db, req, {
    type: 'installation.installer_command_viewed',
    actor: actor.email,
    result: 'accepted',
    installationId,
    installerArtifactId: item.installerArtifact.id,
    installerSha256: item.installerArtifact.sha256,
    installerTokenExpiresAt: item.installerTokenExpiresAt,
    installerTokenRemainingDownloads: item.installerTokenRemainingDownloads,
  });
  await saveDb(db);
  return json(req, res, 200, {
    installation: publicInstallation(item, releaseAtual(db)),
    ...installer,
  });
}

async function handleQuickInstaller(req, res, installationId) {
  const db = await loadDb();
  const item = db.installations[installationId];
  const authorization = String(req.headers.authorization || '');
  const installerToken =
    authorization.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] || '';
  const tokenAccepted =
    item &&
    isInstallerTokenActive(item) &&
    timingSafeTextEquals(
      item.installerTokenHash,
      installerTokenDigest(installerToken),
    );
  if (!tokenAccepted) {
    addAuditEvent(db, req, { type: 'installation.installer_denied', actor: installationId, result: 'denied', installationId });
    await saveDb(db);
    return text(req, res, 404, 'Instalador nao encontrado.\n');
  }
  const centralUrl = publicBaseUrl(req);
  let installerScript;
  try {
    installerScript = buildInstallerScript(item, centralUrl);
    consumeInstallerDownload(item);
  } catch (error) {
    addAuditEvent(db, req, {
      type: 'installation.installer_denied',
      actor: installationId,
      result: 'denied',
      installationId,
    });
    await saveDb(db);
    return text(req, res, 404, 'Instalador nao encontrado.\n');
  }
  addAuditEvent(db, req, {
    type: 'installation.installer_downloaded',
    actor: installationId,
    result: 'accepted',
    installationId,
    installerArtifactId: item.installerArtifact.id,
    installerSha256: item.installerArtifact.sha256,
    installerTokenExpiresAt: item.installerTokenExpiresAt,
    installerTokenRemainingDownloads: item.installerTokenRemainingDownloads,
  });
  await saveDb(db);
  return text(req, res, 200, installerScript, 'text/x-shellscript; charset=utf-8');
}

async function serveStatic(req, res) {
  // Só o CAMINHO vira nome de arquivo. Usar `req.url` cru fazia `/?v=1` virar o
  // arquivo "?v=1" e devolver 404 — ou seja, qualquer URL com parâmetro
  // quebrava, inclusive o `?v=` que é a forma padrão de furar cache de página.
  // Justamente a saída de emergência quando o navegador está preso na versão
  // antiga não funcionava.
  const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safe = path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(PUBLIC_DIR, safe);
  try {
    const data = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css' : 'application/javascript';
    text(req, res, 200, data, type);
  } catch {
    text(req, res, 404, 'not found');
  }
}

// ── Proxy para o build-agent (geração de APK) ───────────────────────────────
async function agentFetch(pathname, init = {}) {
  if (!APP_BUILDER_AGENT_URL) {
    const err = new Error('Build-agent não configurado (APP_BUILDER_AGENT_URL vazio).');
    err.statusCode = 503;
    throw err;
  }
  let res;
  try {
    const timeoutSignal = AbortSignal.timeout(APP_BUILDER_AGENT_TIMEOUT_MS);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    res = await fetch(`${APP_BUILDER_AGENT_URL}${pathname}`, {
      ...init,
      signal,
      headers: {
        'content-type': 'application/json',
        'x-build-token': APP_BUILDER_AGENT_TOKEN,
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    const wrapped = new Error(
      error?.name === 'TimeoutError'
        ? 'Build-agent excedeu o tempo máximo de resposta.'
        : 'Build-agent indisponível.',
    );
    wrapped.statusCode = error?.name === 'TimeoutError' ? 504 : 502;
    wrapped.cause = error;
    throw wrapped;
  }
  const declaredLength = Number(res.headers.get('content-length') || 0);
  if (declaredLength > APP_BUILDER_AGENT_MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    const error = new Error('Resposta do build-agent excede o limite permitido.');
    error.statusCode = 502;
    throw error;
  }
  const chunks = [];
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > APP_BUILDER_AGENT_MAX_RESPONSE_BYTES) {
        await res.body.cancel().catch(() => undefined);
        const error = new Error('Resposta do build-agent excede o limite permitido.');
        error.statusCode = 502;
        throw error;
      }
      chunks.push(Buffer.from(chunk));
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  return { status: res.status, data };
}

async function artifactFetch(pathname) {
  try {
    return await fetch(`${APK_SOURCE_BASE}${pathname}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error(`[central] fonte de artefatos indisponível para ${pathname}:`, error?.cause?.code || error?.name || 'fetch_failed');
    return null;
  }
}

// ── Geração automática de app por cliente ────────────────────────────────────
// Converte um endereço (host, host:porta ou URL) na URL da API do DRAC. Layout
// padrão: web/API atrás do nginx em :5173 com a API em /api.
function addrToApiUrl(addr) {
  let a = String(addr || '').trim();
  if (!a) return '';
  if (/^https?:\/\//i.test(a)) {
    try {
      const u = new URL(a);
      const oldHost = u.hostname.toLowerCase();
      if (oldHost === 'ajustcam.ajustconsulting.com.br') u.hostname = 'principal.s2cam.com.br';
      const tenant = oldHost.match(/^([a-z0-9-]+)\.cam\.ajustconsulting\.com\.br$/)?.[1];
      if (tenant) u.hostname = `${tenant}.s2cam.com.br`;
      if (u.hostname !== oldHost) { u.protocol = 'https:'; u.port = ''; }
      return u.toString().replace(/\/+$/, '').replace(/\/api$/i, '') + '/api';
    } catch { return ''; }
  }
  if (/:\d+$/.test(a)) return `http://${a}/api`;
  // Domínio sem esquema é uma publicação web, portanto HTTPS e /api. Apenas
  // IPv4 sem porta mantém o fallback local legado em :5173.
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(a)) return `https://${a}/api`;
  return `http://${a}:5173/api`;
}

// Endereço privado/loopback/Docker — NÃO serve p/ um celular acessar.
function isPrivateHost(addr) {
  const h = String(addr || '').replace(/^https?:\/\//i, '').split(/[:/]/)[0].trim();
  if (!h) return true;
  if (h === 'localhost' || h === '::1') return true;
  return /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

// Descobre a URL da API do cliente. PRIORIZA endereço PÚBLICO (alcançável pelo
// celular). O IP de origem do heartbeat costuma ser interno do Docker
// (172.17.0.1) — inútil p/ o app; por isso só entra como último recurso.
// Override manual (definido na edição do app) sempre vence.
function deriveClientApiUrl(item) {
  const override = item.app && item.app.apiUrlOverride;
  if (override) return addrToApiUrl(override);

  const candidates = [item.reportedApiUrl, item.provisionedServerAddress, item.observedAddress].filter(Boolean);
  const m = String(item.id || '').match(/(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/);
  const idIp = m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : null;

  for (const c of candidates) if (!isPrivateHost(c)) return addrToApiUrl(c); // público reportado
  if (idIp && !isPrivateHost(idIp)) return addrToApiUrl(idIp);               // IP público do id
  if (candidates.length) return addrToApiUrl(candidates[0]);                 // rede local (fallback)
  if (idIp) return addrToApiUrl(idIp);
  return '';
}

// Slug estável e único por instalação (1 app por cliente). a-z 0-9 -, máx 39.
function deriveAppSlug(item) {
  let s = String(item.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (s.length < 2) s = `app-${s || 'cliente'}`;
  return s.slice(0, 39);
}

// Segmento de package Android válido a partir de um texto livre.
function sanitizePkgSegment(s) {
  let seg = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!seg) seg = 'app';
  if (!/^[a-z]/.test(seg)) seg = `a${seg}`;
  return seg.slice(0, 40);
}

// Package ID padrão LIMPO, derivado do NOME do cliente (não do id com IP).
// Ex.: "Cliente Acme" → com.s2cam.clienteacme. Pacotes já definidos no
// cadastro permanecem imutáveis: mudá-los cria outro app para Android/Play.
function deriveAppPackageId(item) {
  return `com.s2cam.${sanitizePkgSegment(item.customerName || item.name || item.id)}`;
}

const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const BRAND_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const BRAND_LOGO_MAX_CHARS = 550_000;
const BRAND_LOGO_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;

// A Central expõe só a personalização que realmente interessa no dia a dia.
// A paleta completa continua existindo na instalação, mas não deve transformar
// uma troca de logo/cor em um formulário técnico com dezenas de decisões.
function validateManagedBranding(raw, fallbackName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Identidade visual inválida.' };
  }
  const facilityName = String(raw.facilityName || fallbackName || '').trim().slice(0, 200);
  const brandLogoDataUrl = String(raw.brandLogoDataUrl || '').trim();
  const rawMobileLogoScale = Number(raw.brandMobileLogoScale ?? 1);
  const brandMobileLogoScale = Number.isFinite(rawMobileLogoScale)
    ? Math.max(0.65, Math.min(2, rawMobileLogoScale))
    : 1;
  const brandUseDefaultColors = raw.brandUseDefaultColors === true;
  const brandPrimaryColor = String(raw.brandPrimaryColor || '').trim().toLowerCase();
  const brandBackgroundColor = String(raw.brandBackgroundColor || '').trim().toLowerCase();
  if (!facilityName) return { ok: false, message: 'Informe o nome exibido no sistema.' };
  if (brandLogoDataUrl && (brandLogoDataUrl.length > BRAND_LOGO_MAX_CHARS || !BRAND_LOGO_RE.test(brandLogoDataUrl))) {
    return { ok: false, message: 'Logo inválido. Use PNG, JPG ou WebP com até aproximadamente 400 KB.' };
  }
  if (!brandUseDefaultColors && !BRAND_COLOR_RE.test(brandPrimaryColor)) {
    return { ok: false, message: 'Escolha uma cor principal válida no formato #RRGGBB.' };
  }
  if (brandBackgroundColor && !BRAND_COLOR_RE.test(brandBackgroundColor)) {
    return { ok: false, message: 'A cor de fundo deve usar o formato #RRGGBB.' };
  }
  return {
    ok: true,
    value: {
      facilityName,
      brandLogoDataUrl,
      brandMobileLogoScale,
      brandUseDefaultColors,
      brandPrimaryColor: brandUseDefaultColors ? '' : brandPrimaryColor,
      brandBackgroundColor: brandUseDefaultColors ? '' : brandBackgroundColor,
    },
  };
}

// O ícone do launcher é diferente da logo do sistema: fica SOMENTE no
// cadastro de app da Central e nunca desce no heartbeat para a instalação.
// Aceitamos exatamente os mesmos formatos seguros da logo, mas em campo
// próprio para o operador trocar o ícone sem mudar a identidade do painel.
function validateManagedAppIcon(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: '' };
  if (typeof raw !== 'string' || raw.length > BRAND_LOGO_MAX_CHARS || !BRAND_LOGO_RE.test(raw)) {
    return { ok: false, message: 'Ícone inválido. Use PNG, JPG ou WebP com até aproximadamente 400 KB.' };
  }
  return { ok: true, value: raw };
}

function managedBrandingFromInstallation(item, remoteBranding = null) {
  if (item.branding) return item.branding;
  const candidate = item.reportedBranding && typeof item.reportedBranding === 'object'
    ? item.reportedBranding
    : remoteBranding && typeof remoteBranding === 'object' ? remoteBranding : {};
  const fallback = {
    facilityName: effectiveAppName(item),
    brandLogoDataUrl: '',
    brandMobileLogoScale: 1,
    brandUseDefaultColors: true,
    brandPrimaryColor: '',
    brandBackgroundColor: '',
    ...candidate,
  };
  const checked = validateManagedBranding(fallback, effectiveAppName(item));
  return checked.ok ? checked.value : {
    facilityName: effectiveAppName(item),
    brandLogoDataUrl: '',
    brandMobileLogoScale: 1,
    brandUseDefaultColors: true,
    brandPrimaryColor: '',
    brandBackgroundColor: '',
  };
}

// Nome e package efetivos (override do usuário tem prioridade sobre o padrão).
function effectiveAppName(item) {
  return (item.app && item.app.appName) || item.customerName || item.name || deriveAppSlug(item);
}
function effectiveAppPackageId(item) {
  return (item.app && item.app.packageId) || deriveAppPackageId(item);
}

// Nome de arquivo seguro p/ o download (ASCII), derivado do nome do app.
function safeApkFilename(name) {
  let n = String(name || 'app').normalize('NFKD').replace(/[^\w.\- ]/g, '').trim().replace(/\s+/g, '-');
  return `${n || 'app'}.apk`;
}

async function fetchClientBranding(apiUrl, timeoutMs = 8000) {
  if (!apiUrl) return null;
  try {
    const res = await fetch(`${apiUrl}/settings/branding`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Monta o cliente no build-agent a partir do cadastro do cliente + puxa logo/cor
// do próprio sistema dele, e dispara o build. SEM digitação manual.
// Usada tanto pela geração inicial quanto pelo rebuild automático após edição
// (ver handlePatchApp) — os dois caminhos precisam mandar o MESMO payload pro
// build-agent, senão uma edição salva na Central nunca chega no APK.
async function pushAppToBuildAgent(item, actor, req, db, installationId) {
  const approvedRelease = releaseAtual(db);
  if (!approvedRelease?.commit) {
    return {
      status: 409,
      data: { error: 'no_approved_release', message: 'Promova uma release testada antes de gerar o aplicativo.' },
    };
  }
  const apiUrl = deriveClientApiUrl(item);
  if (!apiUrl) {
    return {
      status: 400,
      data: {
        error: 'no_server_address',
        message: 'A Central ainda não conhece o servidor deste cliente. Provisione pela aba Instalação ou aguarde o primeiro heartbeat.',
      },
    };
  }
  const slug = deriveAppSlug(item);
  const appName = effectiveAppName(item);
  const packageId = effectiveAppPackageId(item);
  const remoteBranding = item.branding || item.reportedBranding ? null : await fetchClientBranding(apiUrl);
  const branding = managedBrandingFromInstallation(item, remoteBranding);
  const pushEnabled = item.app?.pushEnabled === true;
  let firebase = null;
  if (pushEnabled) {
    try {
      firebase = await firebaseManagement.ensureAndroidApp({ packageId, displayName: appName });
    } catch (error) {
      const status = Number(error?.status) || 502;
      return {
        status,
        data: {
          error: error?.code || 'firebase_setup_failed',
          message: error instanceof Error ? error.message : 'Não foi possível preparar as notificações do aplicativo.',
        },
      };
    }
  }
  const payload = {
    slug,
    appName,
    apiUrl,
    packageId,
    apkBaseUrl: PUBLIC_APK_BASE,
    crashDsn: MOBILE_CRASH_DSN,
    pushEnabled,
  };
  if (firebase?.configBase64) payload.firebaseConfigBase64 = firebase.configBase64;
  if (!branding.brandUseDefaultColors && branding.brandPrimaryColor) payload.primaryColor = branding.brandPrimaryColor;
  if (branding.brandLogoDataUrl) payload.logoBase64 = branding.brandLogoDataUrl;
  // Prioridade do ícone: ícone específico do aplicativo > logo convertida >
  // ícone padrão S2Cam. `resetAppIcon` limpa no agente qualquer ícone antigo
  // quando a Central não possui uma escolha própria para este cliente.
  const appIcon = String(item.app?.appIconDataUrl || '');
  if (appIcon) payload.appIconBase64 = appIcon;
  payload.resetAppIcon = !appIcon;
  const created = await agentFetch('/clients', { method: 'POST', body: JSON.stringify(payload) });
  if (created.status >= 400) return { status: created.status, data: created.data };
  const build = await agentFetch('/builds', { method: 'POST', body: JSON.stringify({ slug, sourceCommit: approvedRelease.commit }) });
  addAuditEvent(db, req, { type: 'apk.build_started', actor: actor.email, result: build.status < 400 ? 'accepted' : 'denied', installationId });
  item.app = { ...(item.app || {}), slug, apiUrl, appName, packageId, apkBaseUrl: PUBLIC_APK_BASE, pushEnabled: payload.pushEnabled, firebaseAppId: firebase?.firebaseAppId || item.app?.firebaseAppId || null, brandingApplied: !!branding, lastBuildJobId: build.data?.jobId || null, lastBuildAt: new Date().toISOString() };
  return { status: build.status, data: { slug, apiUrl, packageId, firebaseProvisioned: Boolean(firebase), firebaseAppCreated: Boolean(firebase?.created), brandingApplied: !!branding, ...build.data } };
}

async function handleGenerateApp(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const result = await pushAppToBuildAgent(item, actor, req, db, installationId);
  await saveDb(db);
  return json(req, res, result.status, result.data);
}

// Edita nome de exibição, package ID e/ou servidor do app. Se o app já tinha
// sido gerado e houve mudança que chega ao APK, dispara rebuild automaticamente
// — um simples "Salvar" sem alteração não desperdiça uma nova compilação.
async function handlePatchApp(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const body = await readBody(req);
  const appName = String(body.appName || '').trim();
  const packageId = String(body.packageId || '').trim();
  const apiUrl = String(body.apiUrl || '').trim();
  const hasPushSetting = Object.prototype.hasOwnProperty.call(body, 'pushEnabled');
  if (hasPushSetting && typeof body.pushEnabled !== 'boolean') {
    return json(req, res, 400, { error: 'invalid_push_setting', message: 'A configuração de notificações deve ser ligada ou desligada.' });
  }
  if (packageId && !PKG_RE.test(packageId)) {
    return json(req, res, 400, { error: 'invalid_package', message: 'Pacote inválido. Use o formato com.empresa.app (letras, números, pontos).' });
  }
  // O `.+` de antes aceitava aspas/espaço/qualquer coisa após o esquema. Este valor desce
  // até o build-client.sh, que roda no HOST com as keystores — restringe o charset ao que
  // é URL de verdade (mesmo formato validado pelo build-agent).
  if (apiUrl && !/^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(apiUrl) && !/^[a-z0-9.-]+(:\d+)?$/i.test(apiUrl)) {
    return json(req, res, 400, { error: 'invalid_apiurl', message: 'Servidor inválido. Use um domínio (ex.: cliente.s2cam.com.br), IP ou URL completa.' });
  }
  item.app = item.app || { slug: deriveAppSlug(item), apiUrl: deriveClientApiUrl(item) };
  const hadBuild = !!item.app.lastBuildAt;
  const appBefore = JSON.stringify({
    appName: item.app.appName || '',
    packageId: item.app.packageId || '',
    apiUrlOverride: item.app.apiUrlOverride || '',
    pushEnabled: item.app.pushEnabled === true,
  });
  if (appName) item.app.appName = appName;
  if (packageId) item.app.packageId = packageId;
  if (apiUrl) item.app.apiUrlOverride = addrToApiUrl(apiUrl); // override manual do servidor
  if (hasPushSetting) item.app.pushEnabled = body.pushEnabled;

  let appIconChanged = false;
  if (Object.prototype.hasOwnProperty.call(body, 'appIconDataUrl')) {
    const checkedIcon = validateManagedAppIcon(body.appIconDataUrl);
    if (!checkedIcon.ok) return json(req, res, 400, { error: 'invalid_app_icon', message: checkedIcon.message });
    const previousIcon = String(item.app.appIconDataUrl || '');
    appIconChanged = previousIcon !== checkedIcon.value;
    if (checkedIcon.value) item.app.appIconDataUrl = checkedIcon.value;
    else delete item.app.appIconDataUrl;
    if (appIconChanged) {
      addAuditEvent(db, req, {
        type: 'apk.app_icon_changed',
        actor: actor.email,
        result: 'accepted',
        installationId,
        configured: Boolean(checkedIcon.value),
      });
    }
  }
  addAuditEvent(db, req, { type: 'apk.app_edited', actor: actor.email, result: 'accepted', installationId });

  let brandingChanged = false;
  let brandingBuildChanged = false;
  if (Object.prototype.hasOwnProperty.call(body, 'branding')) {
    const previousBranding = managedBrandingFromInstallation(item);
    const checked = validateManagedBranding(body.branding, appName || effectiveAppName(item));
    if (!checked.ok) return json(req, res, 400, { error: 'invalid_branding', message: checked.message });
    brandingChanged = JSON.stringify(item.branding || null) !== JSON.stringify(checked.value);
    const { brandMobileLogoScale: _previousScale, ...previousBuildBranding } = previousBranding;
    const { brandMobileLogoScale: _nextScale, ...nextBuildBranding } = checked.value;
    // O tamanho da logo é lido em runtime pelo app. Alterá-lo não precisa gerar
    // APK/AAB novo nem criar trabalho desnecessário no agente de build.
    brandingBuildChanged = JSON.stringify(previousBuildBranding) !== JSON.stringify(nextBuildBranding);
    item.branding = checked.value;
    if (brandingChanged) {
      bumpConfigRevision(item);
      item.updatedAt = new Date().toISOString();
      addAuditEvent(db, req, {
        type: 'installation.branding_changed',
        actor: actor.email,
        result: 'accepted',
        installationId,
        primaryColor: checked.value.brandPrimaryColor || 'default',
        customBackground: Boolean(checked.value.brandBackgroundColor),
        customLogo: Boolean(checked.value.brandLogoDataUrl),
      });
    }
  }

  let rebuild = null;
  const appSettingsChanged = appBefore !== JSON.stringify({
    appName: item.app.appName || '',
    packageId: item.app.packageId || '',
    apiUrlOverride: item.app.apiUrlOverride || '',
    pushEnabled: item.app.pushEnabled === true,
  });
  if (hadBuild && (appSettingsChanged || brandingBuildChanged || appIconChanged)) {
    rebuild = await pushAppToBuildAgent(item, actor, req, db, installationId);
  }
  await saveDb(db);
  if (rebuild && rebuild.status >= 400) {
    return json(req, res, rebuild.status, { ...rebuild.data, appName: effectiveAppName(item), packageId: effectiveAppPackageId(item), apiUrl: deriveClientApiUrl(item) });
  }
  return json(req, res, 200, {
    app: item.app,
    appName: effectiveAppName(item),
    packageId: effectiveAppPackageId(item),
    apiUrl: deriveClientApiUrl(item),
    pushEnabled: item.app?.pushEnabled === true,
    branding: managedBrandingFromInstallation(item),
    appIconDataUrl: item.app?.appIconDataUrl || '',
    appIconChanged,
    brandingChanged,
    configRevision: Number(item.configRevision || 0) || 0,
    rebuildTriggered: !!rebuild,
    rebuild: rebuild ? rebuild.data : null,
  });
}

// ── Nós de computação por instalação (item 3.2) ──────────────────────────────
// Gerência dos nós como DADO, seguindo o mesmo padrão da PATCH de licença: mesma
// sessão/admin do bloco /api/admin, valida ANTES de salvar, escreve no datastore
// plugável (JSON/PG) sem tabela nova (os nós vivem no objeto da instalação).
// Corpo vazio / [] volta ao single-primary implícito (remove o campo) — INERTE.
async function handlePatchComputeNodes(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const body = await readBody(req);
  // Remoção é o ARRAY VAZIO explícito. Corpo sem a chave, typo (`compute_nodes`) ou
  // tipo errado NÃO podem "apagar todos os nós com 200" — payload malformado é 400.
  if (!Array.isArray(body.computeNodes)) {
    return json(req, res, 400, { error: 'invalid_compute_nodes_payload', details: ['computeNodes deve ser um array (use [] para remover)'] });
  }
  const nodes = normalizeComputeNodes(body.computeNodes);
  const validation = validateComputeNodes(nodes);
  if (!validation.valid) {
    return json(req, res, 400, { error: 'invalid_compute_nodes', details: validation.errors });
  }
  const previousCount = normalizeComputeNodes(item.computeNodes).length;
  if (nodes.length === 0) {
    // Ausência = single-primary implícito. Remove o campo em vez de gravar [] para
    // manter o registro idêntico ao de uma instalação que nunca definiu nós.
    delete item.computeNodes;
  } else {
    item.computeNodes = nodes;
  }
  item.updatedAt = new Date().toISOString();
  addAuditEvent(db, req, {
    type: 'installation.compute_nodes_changed',
    actor: actor.email,
    result: 'accepted',
    installationId,
    from: previousCount,
    to: nodes.length,
  });
  await saveDb(db);
  return json(req, res, 200, publicInstallation(item));
}

// ── Scheduler multi-nó (fase 4) ──────────────────────────────────────────────
// Control-plane orquestrado pela CENTRAL: quem decide qual nó roda o quê.
// Estas rotas só existem com a flag ligada e são de LEITURA/PLANEJAMENTO —
// NADA é executado em nó nenhum (fase futura). O plano fica no objeto da
// instalação (`schedulerPlan`), como os nós: sem tabela nem coluna nova.

// GET: devolve o plano SALVO como está. Não replaneja e não escreve nada — um
// GET que replanejasse trocaria tokens (e migraria câmeras) a cada refresh do
// painel.

/**
 * Define QUAIS IAs a instalação pode rodar — pelo painel, não por linha de comando.
 * Movimento (MOG2) é o essencial: ele ARMA a gravação por movimento, então
 * desligá-lo faz câmeras armadas pararem de gravar (avisado na tela). Objeto e
 * face são pesadas e nascem desligadas. A licença continua sendo o TETO: uma
 * instalação restrita não ganha IA avançada por causa de um clique aqui.
 */
async function handlePatchAiPolicy(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const body = await readBody(req);
  const payload = body && typeof body === 'object' ? body.aiPolicy : null;
  const validation = validateAiPolicy(payload);
  if (!validation.valid) {
    return json(req, res, 400, { error: 'invalid_ai_policy', details: validation.errors });
  }
  const previous = normalizeAiPolicy(item.aiPolicy);
  const next = normalizeAiPolicy({ ...previous, ...payload });
  item.aiPolicy = next;
  item.updatedAt = new Date().toISOString();
  bumpConfigRevision(item);
  addAuditEvent(db, req, {
    type: 'installation.ai_policy_changed',
    actor: actor.email,
    result: 'accepted',
    installationId,
    from: describeAiPolicy(previous),
    to: describeAiPolicy(next),
  });
  await saveDb(db);
  return json(req, res, 200, publicInstallation(item));
}

/**
 * Configura o storage em nuvem DESTA instalação.
 *
 * O segredo nunca volta para o navegador: se o corpo vier sem
 * `secretAccessKey`, mantemos o que já estava salvo (a tela mostra apenas
 * "credencial salva"). Isso permite ajustar bucket/janela sem recolar a chave.
 *
 * A auditoria registra a mudança SEM a credencial — quem lê a trilha precisa
 * saber que mudou e para onde aponta, não a chave do cliente.
 */
/**
 * Marca que a configuração DESEJADA mudou.
 *
 * A revisão é um contador imutável por instalação. É ela que permite a Central
 * afirmar "a instalação aplicou a revisão 42" em vez de inferir por data —
 * inferência que falha justamente no caso perigoso: uma instalação antiga que
 * recebe um campo que não entende, ignora, manda outro heartbeat e some da
 * lista de pendências sem nunca ter aplicado nada.
 */
function bumpConfigRevision(item) {
  const atual = Number(item.configRevision || 0) || 0;
  item.configRevision = atual + 1;
  item.configRevisionAt = new Date().toISOString();
  return item.configRevision;
}

async function handlePatchCloudStorage(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const body = await readBody(req);
  const payload = body && typeof body === 'object' ? body.cloudStorage : null;

  // ESQUEMA INFERIDO. O operador digita `meu-storage.exemplo.com.br` e o sistema
  // descobre se é http ou https sondando os dois — na ordem que tem mais chance
  // de acertar de primeira. Exigir que ele soubesse era transferir para a pessoa
  // um trabalho que a máquina faz melhor.
  if (payload && typeof payload === 'object' && typeof payload.endpoint === 'string' && payload.endpoint.trim()) {
    const resolvido = await resolverEndpoint(payload.endpoint);
    if (resolvido.endpoint) payload.endpoint = resolvido.endpoint;
  }

  const previous = normalizeCloudStorage(item.cloudStorage);
  let existingSecret = '';
  let segredoIlegivel = false;
  try {
    existingSecret = decryptStorageSecret(previous.secretAccessKeyEncrypted);
  } catch {
    existingSecret = '';
    // Chave mestra trocada (ou container subiu sem a env): o texto cifrado
    // existe mas não abre. Seguir com "" faria a validação gravar segredo
    // VAZIO por cima — a credencial do cliente destruída em disco por uma
    // edição banal, sem aviso e sem como recuperar.
    segredoIlegivel = Boolean(previous.secretAccessKeyEncrypted);
  }
  const mandouSegredoNovo = Boolean(payload && typeof payload === 'object'
    && typeof payload.secretAccessKey === 'string' && payload.secretAccessKey.trim());
  if (segredoIlegivel && !mandouSegredoNovo) {
    return json(req, res, 409, {
      error: 'storage_secret_unreadable',
      message: 'A credencial guardada não pôde ser decifrada (a chave mestra da Central mudou?). '
        + 'Digite a Secret Access Key novamente para regravá-la — salvar sem ela apagaria a credencial atual.',
    });
  }

  // Prefixos já em uso pelas OUTRAS instalações: dois clientes no mesmo
  // endpoint+bucket+prefixo compartilham espaço de chaves e a limpeza de um
  // apaga o acervo do outro.
  const prefixosEmUso = Object.entries(db.installations || {})
    .filter(([id]) => id !== installationId)
    .map(([id, outra]) => {
      const c = normalizeCloudStorage(outra && outra.cloudStorage);
      return { installationId: id, endpoint: c.endpoint, bucket: c.bucket, prefix: c.prefix };
    })
    .filter((uso) => uso.endpoint && uso.bucket);

  let validation;
  try {
    validation = validateCloudStorage({ ...previous, ...payload }, { existingSecret, installationId, prefixosEmUso });
  } catch (error) {
    // CENTRAL_STORAGE_SECRET ausente/fraco: a Central não pode guardar
    // credencial de cliente sem chave decente, e falhar alto é melhor que
    // salvar mal protegido.
    return json(req, res, 500, { error: 'storage_secret_unavailable', message: String(error.message || error) });
  }
  if (!validation.ok) {
    return json(req, res, 400, { error: 'invalid_cloud_storage', details: validation.errors });
  }

  item.cloudStorage = validation.value;

  // TESTA JÁ, na mesma ação. Antes o painel aceitava qualquer credencial em
  // silêncio e a única pista era um selo vermelho discreto no cartão, horas
  // depois — o operador ficava procurando erro no endpoint quando o problema
  // era a chave. Testar aqui transforma "salvou" em "salvou e funciona", que é
  // a única coisa que ele queria saber.
  //
  // Falhar NÃO impede de salvar: storage que ainda vai subir, ou firewall no
  // caminho, precisam poder ser configurados antes. O resultado desce junto e a
  // tela mostra.
  const verificacao = await verificarStorage(validation.value).catch(() => null);
  if (verificacao) {
    item.cloudStorage = {
      ...validation.value,
      lastTestAt: new Date().toISOString(),
      lastTestOk: verificacao.ok,
    };
  }

  // ── POR QUE NÃO BLOQUEAMOS A HABILITAÇÃO COM TESTE REPROVADO ──────────────
  //
  // A auditoria propôs recusar `enabled: true` quando a verificação falha,
  // apontando isso como origem do `NoSuchBucket` desta instalação. A EVIDÊNCIA
  // desmente: o registro mostra `lastTestOk: true` em 04/08 13:58 — o teste
  // PASSOU, e o bucket foi apagado externamente no dia seguinte. A trava não
  // teria evitado o incidente, e quebraria um fluxo deliberado e documentado
  // ("storage que ainda vai subir, ou firewall no caminho, precisam poder ser
  // configurados antes").
  //
  // Contra "o destino morre DEPOIS de configurado" — que é o caso real — o que
  // protege é a vigilância contínua, já no ar: saúde do envio no heartbeat,
  // linha vermelha na Central e verificação do acervo no bucket. Trava na
  // configuração é remédio para outra doença.

  item.updatedAt = new Date().toISOString();
  bumpConfigRevision(item);
  addAuditEvent(db, req, {
    type: 'installation.cloud_storage_changed',
    actor: actor.email,
    result: 'accepted',
    installationId,
    from: describeCloudStorage(previous),
    to: describeCloudStorage(item.cloudStorage),
    testeOk: verificacao ? verificacao.ok : null,
  });
  await saveDb(db);
  return json(req, res, 200, {
    cloudStorage: describeCloudStorage(item.cloudStorage),
    teste: verificacao,
  });
}

/**
 * EXCLUI o armazenamento em nuvem desta instalação.
 *
 * Não é o mesmo que desabilitar. Desabilitar é pausa — o cadastro fica, e
 * religar volta tudo ao que era. Excluir diz "este destino acabou", e a
 * instalação reage escolhendo outro storage que ainda tenha ou voltando a
 * gravar só no disco local.
 *
 * O QUE ACONTECE COM AS GRAVAÇÕES: nada é apagado. Os objetos continuam no
 * fornecedor e a instalação continua sabendo ler dali, porque ela guarda o
 * vínculo de cada gravação com o storage de origem. Excluir aqui tira o
 * DESTINO, não o acervo. Quem quiser apagar de verdade usa "Esvaziar" na tela
 * de Armazenamento da instalação, que é uma decisão separada e irreversível.
 */
async function handleDeleteCloudStorage(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });

  const anterior = normalizeCloudStorage(item.cloudStorage);
  if (!anterior.endpoint && !anterior.bucket && !anterior.accessKeyId) {
    await saveDb(db);
    return json(req, res, 404, { error: 'storage_not_set', message: 'Esta instalação não tem armazenamento em nuvem.' });
  }

  // LÁPIDE da exclusão: o endereço do storage que saiu. É por ela que a
  // instalação sabe QUAL storage expurgar — sem isso ela só saberia que "não
  // há storage provisionado", que também acontece quando o envio é pausado.
  // Guardadas as últimas 10: passado esse ponto, uma instalação que ficou
  // offline tanto tempo precisa de atenção humana, não de fila infinita.
  const lapides = Array.isArray(item.cloudStorageRemovals) ? item.cloudStorageRemovals : [];
  lapides.push({
    endpoint: anterior.endpoint,
    bucket: anterior.bucket,
    prefix: anterior.prefix,
    deletedAt: new Date().toISOString(),
  });
  item.cloudStorageRemovals = lapides.slice(-10);

  item.cloudStorage = normalizeCloudStorage(null);
  item.updatedAt = new Date().toISOString();
  // Sem bump de revisão a instalação não saberia que precisa reagir: ela compara
  // a revisão desejada com a aplicada para decidir se houve mudança.
  bumpConfigRevision(item);
  addAuditEvent(db, req, {
    type: 'installation.cloud_storage_deleted',
    actor: actor.email,
    result: 'accepted',
    installationId,
    from: describeCloudStorage(anterior),
  });
  await saveDb(db);
  return json(req, res, 200, { cloudStorage: describeCloudStorage(item.cloudStorage) });
}

/**
 * Mostra a Secret Access Key de volta para quem opera a Central.
 *
 * A credencial não é do painel: é do CLIENTE, que contratou o storage e um dia
 * vai precisar dela para conferir com o fornecedor, reconfigurar em outro lugar
 * ou responder a uma auditoria. Esconder para sempre não protege ninguém —
 * quem tem sessão de administrador aqui já pode SUBSTITUIR o segredo pelo
 * formulário, então negar a leitura só obrigava a reemitir a chave no
 * fornecedor para descobrir o que já está guardado.
 *
 * O que protege de verdade é o rastro: cada exibição vira evento de auditoria
 * com quem, quando e de qual IP. Por isso é uma rota separada, chamada só no
 * clique do olho, e não um campo a mais no payload da tela — a listagem das
 * instalações continua sem segredo nenhum.
 */
async function handleRevealCloudStorageSecret(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });

  const config = normalizeCloudStorage(item.cloudStorage);
  if (!config.secretAccessKeyEncrypted) {
    await saveDb(db);
    return json(req, res, 404, {
      error: 'secret_not_set',
      message: 'Esta instalação ainda não tem uma Secret Access Key guardada.',
    });
  }

  let secret = '';
  try {
    secret = decryptStorageSecret(config.secretAccessKeyEncrypted);
  } catch (error) {
    // Chave mestra da Central trocada depois que o segredo foi guardado: o
    // texto cifrado virou lixo. Dizer isso é melhor que devolver vazio e deixar
    // o operador achar que nunca cadastrou nada.
    await saveDb(db);
    return json(req, res, 409, {
      error: 'secret_unreadable',
      message: 'A credencial guardada não pôde ser decifrada (CENTRAL_STORAGE_SECRET mudou). Cadastre-a novamente.',
    });
  }
  if (!secret) {
    await saveDb(db);
    return json(req, res, 409, { error: 'secret_unreadable', message: 'A credencial guardada está vazia.' });
  }

  addAuditEvent(db, req, {
    type: 'installation.cloud_storage_secret_revealed',
    actor: actor.email,
    result: 'accepted',
    installationId,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
  });
  await saveDb(db);
  return json(req, res, 200, { accessKeyId: config.accessKeyId, secretAccessKey: secret });
}

/**
 * Testa a credencial CONTRA O BUCKET, a partir da Central.
 *
 * Testar aqui (e não só na instalação) é deliberado: o operador está no painel
 * configurando, e descobrir que a chave está errada só quando a instalação
 * tentar subir a primeira gravação é tarde demais — já se perdeu vídeo.
 *
 * O teste faz LIST **e** PUT+DELETE: credencial somente-leitura passaria num
 * teste de listagem e falharia na primeira gravação.
 */
/**
 * DESEMPENHO do bucket, a partir da Central.
 *
 * O NÚMERO NÃO É O MESMO da tela de Armazenamento da instalação, e a diferença
 * importa: aqui se mede o link da CENTRAL até o bucket. Serve para avaliar o
 * FORNECEDOR — está lento hoje? este candidato é melhor que aquele? — e para
 * comparar antes de contratar. NÃO serve para dimensionar quantas câmeras a
 * instalação aguenta, porque a instalação está em outra rede.
 *
 * Custa banda e requisições cobradas, então é botão e nunca automático.
 */
async function handleCloudStoragePerformance(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });

  const config = normalizeCloudStorage(item.cloudStorage);
  let secret = '';
  try {
    secret = decryptStorageSecret(config.secretAccessKeyEncrypted);
  } catch {
    secret = '';
  }
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !secret) {
    return json(req, res, 400, {
      error: 'cloud_storage_incomplete',
      message: 'Configure endpoint, bucket e credencial antes de medir.',
    });
  }

  const corpo = await readBody(req).catch(() => null);
  const pedido = Number(corpo && typeof corpo === 'object' ? corpo.sizeMb : 0);
  const medicao = await measureS3Performance({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix,
    accessKeyId: config.accessKeyId,
    secretAccessKey: secret,
    forcePathStyle: config.forcePathStyle,
  }, pedido > 0
    // PRAZO PROPORCIONAL AO QUE FOI PEDIDO.
    //
    // O prazo fixo de 5 min servia para o modo Automático, que se ajusta ao
    // link. Quando o operador ESCOLHE 64 MB, a descida leva o tempo que tiver
    // de levar: neste link, 64 MB a ~1 Mb/s são 8,5 minutos — abortar aos 5 e
    // dizer "falhou" seria mentir sobre um teste que estava indo bem.
    //
    // 25s por MB equivale a suportar um link de ~0,32 Mb/s, bem abaixo do pior
    // caso plausível. Teto de 30 min: acima disso o número já não ajuda ninguém
    // a decidir nada, e uma requisição pendurada por mais tempo é problema.
    ? { sizeMb: pedido, timeoutMs: Math.min(1_800_000, Math.max(300_000, pedido * 25_000)) }
    : {});

  // Contexto que transforma o número em resposta: 143ms parece distância e não
  // é. Decompor mostra que a REDE são ~35ms e o resto é abrir a conexão — e o
  // keep-alive diz se esse custo se repete a cada objeto.
  const rede = await diagnosticarConexao(config.endpoint).catch(() => null);
  const local = rede && rede.ip ? await localizarServidor(rede.ip).catch(() => null) : null;
  if (medicao && typeof medicao === 'object') {
    medicao.rede = rede;
    medicao.local = local;
  }

  // Esta rota roda FORA do portão (ela dura minutos). A gravação é a única
  // parte com corrida, então ela — e só ela — entra na fila: relê o banco
  // FRESCO para não sobrescrever o que chegou durante a medição.
  await runSerialized(async () => {
    const atual = await loadDb();
    addAuditEvent(atual, req, {
      type: 'installation.cloud_storage_measured',
      actor: actor.email,
      result: medicao.ok ? 'accepted' : 'rejected',
      installationId,
      bucket: config.bucket,
    });
    await saveDb(atual);
  });
  return json(req, res, medicao.ok ? 200 : 502, medicao);
}

/**
 * Roda o teste de acesso sobre uma configuração já validada.
 *
 * Devolve `null` quando não há o que testar (desabilitado ou incompleto): nesse
 * caso não existe resposta honesta, e inventar "falhou" assustaria sem motivo.
 */
async function verificarStorage(config) {
  if (!config.enabled) return null;
  let secret = '';
  try {
    secret = decryptStorageSecret(config.secretAccessKeyEncrypted);
  } catch {
    secret = '';
  }
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !secret) return null;
  return testS3Access({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix,
    accessKeyId: config.accessKeyId,
    secretAccessKey: secret,
    forcePathStyle: config.forcePathStyle,
  }, { timeoutMs: 12000 });
}


// ── ALERTAS POR INSTALAÇÃO ──────────────────────────────────────────────────

async function handlePatchAlertas(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });

  const body = await readBody(req);
  const payload = body && typeof body === 'object' ? body.alertas : null;
  if (!payload || typeof payload !== 'object') {
    return json(req, res, 400, { error: 'alertas_payload_invalido' });
  }

  // Endereço inválido é RECUSADO com a lista do que caiu, em vez de aceito e
  // descartado em silêncio: salvar "ok" e o alerta nunca chegar é o pior
  // resultado possível numa tela de alerta.
  if (Array.isArray(payload.emails)) {
    const invalidos = payload.emails
      .map((e) => String(e ?? '').trim())
      .filter((e) => e && !alertas.emailPlausivel(e));
    if (invalidos.length) {
      return json(req, res, 400, { error: 'email_invalido', invalidos: invalidos.slice(0, 5) });
    }
    if (payload.emails.filter(Boolean).length > alertas.LIMITE_EMAILS) {
      return json(req, res, 400, { error: 'email_limite', limite: alertas.LIMITE_EMAILS });
    }
  }

  let config;
  try {
    config = alertas.mesclarAlertas(item.alertChannels, payload);
  } catch (erro) {
    // Sem CENTRAL_STORAGE_SECRET não dá para cifrar o token — e gravar em claro
    // seria pior que recusar.
    return json(req, res, 500, { error: 'segredo_indisponivel', message: String(erro?.message || erro) });
  }

  item.alertChannels = config;
  item.updatedAt = new Date().toISOString();
  addAuditEvent(db, req, {
    type: 'alertas.updated',
    actor: actor.email,
    result: 'accepted',
    installationId,
    detail: `email=${config.emailEnabled ? config.emails.length : 0} telegram=${config.telegramEnabled}`,
  });
  await saveDb(db);
  return json(req, res, 200, { alertas: alertas.alertasPublicos(config) });
}

async function handleTestarAlertas(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });

  const config = alertas.normalizarAlertas(item.alertChannels);
  if (!config.telegramEnabled && !config.emailEnabled) {
    return json(req, res, 400, { error: 'nenhum_canal_configurado' });
  }

  const mensagem = alertas.montarMensagem({
    instalacao: item,
    alertas: [{ message: 'Mensagem de teste enviada pelo painel da Central. Se você recebeu isto, o canal está funcionando.' }],
  });
  const resultados = await alertas.despacharAlerta(config, mensagem);
  const ok = resultados.length > 0 && resultados.every((r) => r.ok);

  // O selo é escrito pelo SERVIDOR a partir do resultado REAL — nunca aceito
  // do corpo. Mesma lição do teste de storage.
  item.alertChannels = {
    ...config,
    ultimoTesteAt: new Date().toISOString(),
    ultimoTesteOk: ok,
    ultimoTesteMensagem: ok
      ? `Enviado com sucesso (${resultados.map((r) => r.canal).join(', ')}).`
      : resultados.filter((r) => !r.ok).map((r) => `${r.canal}: ${r.erro}`).join(' | ').slice(0, 300),
  };
  addAuditEvent(db, req, {
    type: 'alertas.test',
    actor: actor.email,
    result: ok ? 'accepted' : 'denied',
    installationId,
  });
  await saveDb(db);
  return json(req, res, ok ? 200 : 502, { ok, resultados, alertas: alertas.alertasPublicos(item.alertChannels) });
}

async function handleTestCloudStorage(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });

  const config = normalizeCloudStorage(item.cloudStorage);
  let secret = '';
  try {
    secret = decryptStorageSecret(config.secretAccessKeyEncrypted);
  } catch {
    secret = '';
  }
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !secret) {
    return json(req, res, 400, { error: 'cloud_storage_incomplete' });
  }

  const started = Date.now();
  const result = await testS3Access({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix,
    accessKeyId: config.accessKeyId,
    secretAccessKey: secret,
    forcePathStyle: config.forcePathStyle,
  });

  item.cloudStorage = {
    ...config,
    lastTestAt: new Date().toISOString(),
    lastTestOk: result.ok,
  };
  addAuditEvent(db, req, {
    type: 'installation.cloud_storage_tested',
    actor: actor.email,
    result: result.ok ? 'accepted' : 'rejected',
    installationId,
    detail: result.ok ? 'ok' : result.error,
  });
  await saveDb(db);

  return json(req, res, result.ok ? 200 : 400, {
    ok: result.ok,
    error: result.ok ? null : result.error,
    canWrite: result.canWrite ?? false,
    elapsedMs: Date.now() - started,
  });
}

async function handleGetSchedulerPlan(req, res, db, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  await saveDb(db);
  // O painel precisa saber o estado do interruptor mesmo com ele DESLIGADO (é
  // como desenha a tela). `enabled` na resposta é o interruptor DESTA instalação
  // e vem DEPOIS do spread de propósito: o `enabled` do planView significa outra
  // coisa (recurso disponível na Central — sempre true dentro desta rota) e
  // sobrescreveria o valor real se viesse por último.
  return json(req, res, 200, {
    ...scheduler.planView(item),
    featureAvailable: true,
    enabled: item.schedulerEnabled === true,
  });
}

/**
 * Liga/desliga o scheduler DESTA instalação pelo painel — o que tira a operação
 * de escala da linha de comando (era env + recriar container). Desligar NÃO apaga
 * os nós nem o plano salvo: só para de escalonar, e religar retoma de onde parou
 * (o replanejamento minimiza migração a partir do plano anterior).
 */
async function handlePatchSchedulerEnabled(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const body = await readBody(req);
  if (typeof body.enabled !== 'boolean') {
    return json(req, res, 400, { error: 'invalid_scheduler_payload', details: ['enabled deve ser boolean'] });
  }
  const previous = item.schedulerEnabled === true;
  item.schedulerEnabled = body.enabled;
  item.updatedAt = new Date().toISOString();
  addAuditEvent(db, req, {
    type: 'installation.scheduler_toggled',
    actor: actor.email,
    result: 'accepted',
    installationId,
    from: previous,
    to: body.enabled,
  });
  await saveDb(db);
  return json(req, res, 200, publicInstallation(item));
}

// POST: força o replanejamento. `previous` é o plano salvo (ou, na primeira vez,
// o próprio registro), então replanejar MINIMIZA migração por construção.
// `dryRun:true` calcula e devolve sem persistir (simulação de "e se…").
async function handleSchedulerReplan(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const body = await readBody(req);
  // Mesma regra da PATCH de compute-nodes: payload malformado é 400, nunca um
  // 200 que planeja com dado errado.
  if (body.workloads !== undefined && !Array.isArray(body.workloads)) {
    return json(req, res, 400, { error: 'invalid_scheduler_payload', details: ['workloads deve ser um array'] });
  }
  if (body.nodeStates !== undefined && (!body.nodeStates || typeof body.nodeStates !== 'object' || Array.isArray(body.nodeStates))) {
    return json(req, res, 400, { error: 'invalid_scheduler_payload', details: ['nodeStates deve ser um objeto { nodeId: { lastSeenAt, draining, status } }'] });
  }
  const validation = validateComputeNodes(normalizeComputeNodes(item.computeNodes));
  if (!validation.valid) {
    return json(req, res, 400, { error: 'invalid_compute_nodes', details: validation.errors });
  }

  let plan;
  try {
    plan = scheduler.planForInstallation(item, {
      now: new Date(), // o relógio entra AQUI; o algoritmo não o lê sozinho
      config: SCHEDULER,
      workloads: body.workloads,
      nodeStates: body.nodeStates,
    });
  } catch (error) {
    if (error && error.code === 'too_many_workloads') {
      return json(req, res, 400, { error: 'too_many_workloads', message: error.message });
    }
    throw error;
  }

  const dryRun = body.dryRun === true;
  if (!dryRun) {
    // NÃO mexemos em item.updatedAt: replanejar não é mudança de política do
    // cliente (updatedAt > lastHeartbeatAt marcaria "política pendente" à toa).
    item[scheduler.PLAN_FIELD] = plan;
    addAuditEvent(db, req, {
      type: 'installation.scheduler_replanned',
      actor: actor.email,
      result: 'accepted',
      installationId,
      epoch: plan.epoch,
      migrations: plan.stats.migrations,
      unassigned: plan.stats.unassigned,
    });
  }
  await saveDb(db);
  return json(req, res, 200, { enabled: true, installationId, dryRun, plan });
}

async function handleInstallationApp(req, res, db, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const slug = deriveAppSlug(item);
  // As duas origens podem estar indisponíveis; consultá-las em paralelo evita
  // somar timeouts e deixar o clique em "Editar" parecendo travado.
  const [agentResult, remoteBranding] = await Promise.all([
    agentFetch('/clients').catch(() => null),
    item.branding || item.reportedBranding ? Promise.resolve(null) : fetchClientBranding(deriveClientApiUrl(item), 3000),
  ]);
  const client = (agentResult?.data?.clients || []).find((c) => c.slug === slug) || null;
  return json(req, res, 200, {
    slug,
    apiUrl: deriveClientApiUrl(item),
    appName: effectiveAppName(item),
    packageId: effectiveAppPackageId(item),
    pushEnabled: item.app?.pushEnabled === true,
    appIconDataUrl: item.app?.appIconDataUrl || '',
    branding: managedBrandingFromInstallation(item, remoteBranding),
    brandingDelivery: {
      desiredRevision: Number(item.configRevision || 0) || 0,
      appliedRevision: Number(item.appliedConfigRevision || 0) || 0,
      status: item.configApplyStatus || 'UNKNOWN',
      error: item.configApplyError || null,
    },
    client,
  });
}

// ── Instalação remota via SSH ────────────────────────────────────────────────
// Monta o comando de instalação numa única linha (para `conn.exec`). Em Debian/
// Ubuntu instala o curl se faltar; outras distros precisam de curl pré-instalado.
function buildRemoteInstallCommand(item, centralUrl) {
  const ensureCurl = '(command -v curl >/dev/null 2>&1 || (apt-get update -y && apt-get install -y curl))';
  return `${ensureCurl} && ${buildApprovedInstallerCommand(item, centralUrl)}`;
}

function appendInstallLog(job, chunk, secrets = []) {
  let text = String(chunk);
  for (const s of secrets) {
    if (s) text = text.split(s).join('••••••');
  }
  job.log += text;
  if (job.log.length > 200_000) job.log = job.log.slice(-200_000);
}

function pruneRemoteInstalls() {
  if (remoteInstalls.size <= REMOTE_INSTALL_KEEP) return;
  const ids = [...remoteInstalls.keys()];
  for (const id of ids.slice(0, ids.length - REMOTE_INSTALL_KEEP)) remoteInstalls.delete(id);
}

// Executa a instalação via SSH. A SENHA é usada de forma transitória e NUNCA é
// gravada (nem no log, nem no banco). Atualiza job.status e o log em streaming.
function runRemoteInstall(job, conn, opts, command) {
  const { Client } = require('ssh2');
  job.status = 'running';
  appendInstallLog(job, `>> conectando em ${opts.username}@${opts.host}:${opts.port}…\n`);

  const client = conn || new Client();
  const finish = (status, code) => {
    if (job.status === 'done' || job.status === 'failed') return;
    job.status = status;
    job.exitCode = code ?? null;
    job.finishedAt = new Date().toISOString();
    try { client.end(); } catch { /* ignore */ }
  };

  client
    .on('ready', () => {
      appendInstallLog(job, '>> conectado. iniciando instalador…\n');
      client.exec(command, { pty: true }, (err, stream) => {
        if (err) {
          appendInstallLog(job, `>> erro ao executar: ${err.message}\n`);
          return finish('failed', null);
        }
        stream
          .on('close', (code) => {
            appendInstallLog(job, `\n>> instalador finalizou com código ${code}.\n`);
            finish(code === 0 ? 'done' : 'failed', code);
          })
          .on('data', (d) => appendInstallLog(job, d, [opts.password]))
          .stderr.on('data', (d) => appendInstallLog(job, d, [opts.password]));
      });
    })
    .on('error', (err) => {
      appendInstallLog(job, `>> falha de conexão SSH: ${err.message}\n`);
      finish('failed', null);
    })
    .connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      readyTimeout: 20_000,
      // TOFU DE VERDADE. Antes o comentário dizia "TOFU" mas nada era guardado nem
      // comparado — na prática aceitava QUALQUER host key, ou seja, a senha ROOT do
      // servidor do cliente ia para quem respondesse naquele IP (MITM, DNS envenenado,
      // IP reciclado). Agora: 1ª conexão aprende e persiste a fingerprint; nas seguintes,
      // divergência ABORTA antes de enviar a senha.
      hostVerifier: (key) => {
        const fingerprint = crypto.createHash('sha256').update(key).digest('base64');
        if (opts.knownHostKey) {
          if (timingSafeTextEquals(opts.knownHostKey, fingerprint)) return true;
          appendInstallLog(
            job,
            `>> ABORTADO: a host key SSH deste servidor MUDOU (esperada SHA256:${opts.knownHostKey}, ` +
              `recebida SHA256:${fingerprint}). Pode ser man-in-the-middle. Se a troca foi legítima ` +
              `(reinstalação do servidor), limpe a chave conhecida na instalação e tente de novo.\n`,
          );
          return false;
        }
        appendInstallLog(job, `>> host key aprendida (SHA256:${fingerprint}) — será exigida nas próximas conexões.\n`);
        if (typeof opts.onLearnHostKey === 'function') opts.onLearnHostKey(fingerprint);
        return true;
      },
      algorithms: undefined,
    });
}

async function handleRemoteInstall(req, res, installationId) {
  // Parsing e SSH não devem ocupar o lock. Toda mutação usa snapshot fresco.
  const body = await readBody(req);
  return runSerialized(async () => {
    const db = await loadDb();
    const actor = getAuthenticatedUser(req, db);
    if (!actor) return json(req, res, 401, { error: 'unauthorized' });
    return prepareRemoteInstall(req, res, db, actor, installationId, body);
  });
}

async function prepareRemoteInstall(req, res, db, actor, installationId, body) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const host = String(body.host || item.provisionedServerAddress || '').trim();
  const port = Number(body.port || 22);
  const username = String(body.username || 'root').trim();
  const password = String(body.password || '');
  if (!host) return json(req, res, 400, { error: 'missing_host', message: 'Informe o endereço/IP do servidor.' });
  if (!password) return json(req, res, 400, { error: 'missing_password', message: 'Informe a senha de acesso (root).' });

  const centralUrl = publicBaseUrl(req);
  let command;
  try {
    // Instalações antigas só podem entrar no caminho SSH depois de receber o
    // mesmo vínculo imutável usado pelos comandos manuais.
    refreshInstallerGrant(item, { issueToken: false, release: releaseAtual(db) });
    command = buildRemoteInstallCommand(item, centralUrl);
  } catch (error) {
    if (error instanceof InstallerConfigurationError) {
      return installerConfigurationResponse(req, res);
    }
    throw error;
  }
  const jobId = `${Date.now()}-${installationId}`;
  const job = {
    id: jobId,
    installationId,
    host,
    username,
    status: 'queued',
    log: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
  };
  remoteInstalls.set(jobId, job);
  pruneRemoteInstalls();

  // Marca tentativa + auditoria (sem credenciais).
  item.remoteInstall = { jobId, host, username, startedAt: job.startedAt, startedBy: actor.email };
  item.updatedAt = new Date().toISOString();
  addAuditEvent(db, req, {
    type: 'installation.remote_install_started',
    actor: actor.email,
    result: 'accepted',
    installationId,
    installerArtifactId: item.installerArtifact.id,
    installerSha256: item.installerArtifact.sha256,
  });
  await saveDb(db);

  // TOFU da host key SSH: guardada por host:porta (um mesmo cliente pode trocar de
  // servidor, e servidores diferentes têm chaves diferentes).
  const hostKeyId = `${host}:${port}`;
  const knownHostKey = (item.sshHostKeys || {})[hostKeyId] || null;
  const onLearnHostKey = (fingerprint) => {
    void runSerialized(async () => {
      const fresh = await loadDb();
      const target = fresh.installations[installationId];
      if (!target) return;
      target.sshHostKeys = { ...(target.sshHostKeys || {}), [hostKeyId]: fingerprint };
      await saveDb(fresh);
    }).catch(() => {
      /* aprender a chave é best-effort: não deve derrubar a instalação em curso */
    });
  };

  // Dispara em background; o cliente acompanha por GET /remote-installs/:id.
  runRemoteInstall(job, null, { host, port, username, password, knownHostKey, onLearnHostKey }, command);

  return json(req, res, 202, { jobId, status: job.status });
}

function publicRemoteInstall(job) {
  if (!job) return null;
  return {
    id: job.id,
    installationId: job.installationId,
    host: job.host,
    username: job.username,
    status: job.status,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    log: job.log,
  };
}

// ── Usuários da Central (multi-admin) ────────────────────────────────────────
function publicUsers(db) {
  const out = [{
    email: ADMIN_EMAIL,
    name: 'Administrador',
    builtin: true,
    permissions: [TECHNICAL_DOCUMENTATION_PERMISSION],
  }];
  for (const [email, u] of Object.entries(db.users || {})) {
    out.push({
      email,
      name: u.name || email,
      builtin: false,
      createdAt: u.createdAt || null,
      createdBy: u.createdBy || null,
      permissions: normalizeCentralPermissions(u.permissions),
    });
  }
  return out;
}
async function handleListUsers(req, res, db) {
  await saveDb(db);
  return json(req, res, 200, { users: publicUsers(db), adminEmail: ADMIN_EMAIL });
}
async function handleUpsertUser(req, res, db, actor) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const hasPermissionsUpdate = Object.prototype.hasOwnProperty.call(body, 'permissions');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, res, 400, { error: 'invalid_email', message: 'E-mail inválido.' });
  if (email === ADMIN_EMAIL) return json(req, res, 400, { error: 'reserved_email', message: 'Este e-mail é o administrador do sistema (definido no servidor) e não é editável aqui.' });
  if (password && !isStrongPassword(password)) return json(req, res, 400, { error: 'weak_password', message: 'Use ao menos 12 caracteres, com maiúscula, minúscula e número.' });
  if (hasPermissionsUpdate) {
    const requested = body.permissions;
    const invalid = !Array.isArray(requested)
      || requested.some((permission) => typeof permission !== 'string' || !ALLOWED_CENTRAL_PERMISSIONS.has(permission));
    if (invalid) {
      return json(req, res, 400, {
        error: 'invalid_permissions',
        message: 'A lista de permissões contém um valor inválido.',
      });
    }
    if (!canManageTechnicalAccess(actor)) {
      addAuditEvent(db, req, {
        type: 'user.technical_access_denied',
        actor: actor.email,
        result: 'denied',
        installationId: email,
      });
      await saveDb(db);
      return json(req, res, 403, {
        error: 'technical_access_manager_required',
        message: 'Somente o administrador nativo, em uma sessão interativa, pode alterar o acesso técnico.',
      });
    }
  }
  db.users = db.users || {};
  const existing = db.users[email];
  if (!existing && !password) return json(req, res, 400, { error: 'password_required', message: 'Defina uma senha para o novo usuário.' });
  const previousPermissions = normalizeCentralPermissions(existing?.permissions);
  const nextPermissions = hasPermissionsUpdate
    ? normalizeCentralPermissions(body.permissions)
    : previousPermissions;
  db.users[email] = {
    name: name || (existing && existing.name) || email,
    passwordHash: password ? hashPassword(password) : existing.passwordHash,
    createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    createdBy: (existing && existing.createdBy) || actor.email,
    authVersion: password
      ? (existing
        ? (Number.isInteger(existing.authVersion) ? existing.authVersion : 1) + 1
        : 1)
      : (Number.isInteger(existing?.authVersion) ? existing.authVersion : 1),
    permissions: nextPermissions,
  };
  const revokedSessions = password ? revokeUserSessions(db, email) : 0;
  addAuditEvent(db, req, {
    type: existing ? 'user.updated' : 'user.created',
    actor: actor.email,
    result: 'accepted',
    installationId: email,
    revokedSessions,
  });
  if (hasPermissionsUpdate && previousPermissions.join('\n') !== nextPermissions.join('\n')) {
    addAuditEvent(db, req, {
      type: 'user.technical_access_changed',
      actor: actor.email,
      result: 'accepted',
      installationId: email,
      technicalAccess: nextPermissions.includes(TECHNICAL_DOCUMENTATION_PERMISSION),
    });
  }
  await saveDb(db);
  return json(req, res, 200, { ok: true });
}

async function handleTechnicalDocumentation(req, res, db, actor) {
  const allowed = actor.method === 'session'
    && hasCentralPermission(actor, TECHNICAL_DOCUMENTATION_PERMISSION);
  if (!allowed) {
    addAuditEvent(db, req, {
      type: 'technical_documentation.denied',
      actor: actor.email,
      result: 'denied',
    });
    await saveDb(db);
    return json(req, res, 403, {
      error: 'technical_documentation_forbidden',
      message: 'Esta conta não possui acesso ao Portal técnico.',
    });
  }
  addAuditEvent(db, req, {
    type: 'technical_documentation.viewed',
    actor: actor.email,
    result: 'accepted',
  });
  await saveDb(db);
  return json(req, res, 200, { document: TECHNICAL_DOCUMENTATION });
}
async function handleDeleteUser(req, res, db, actor, emailRaw) {
  const email = String(emailRaw || '').toLowerCase();
  if (email === ADMIN_EMAIL) return json(req, res, 400, { error: 'reserved_email', message: 'Não é possível remover o administrador do sistema.' });
  if (email === actor.email) return json(req, res, 400, { error: 'self_delete', message: 'Você não pode remover a própria conta logada.' });
  if (!db.users || !db.users[email]) return json(req, res, 404, { error: 'user_not_found' });
  delete db.users[email];
  const revokedSessions = revokeUserSessions(db, email);
  addAuditEvent(db, req, {
    type: 'user.deleted',
    actor: actor.email,
    result: 'accepted',
    installationId: email,
    revokedSessions,
  });
  await saveDb(db);
  return json(req, res, 200, { ok: true });
}

async function route(req, res) {
  if (req.method === 'OPTIONS') return empty(req, res, 204);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      // `build` é a data de modificação do arquivo servido ao navegador.
      //
      // Existe por um motivo concreto: a Central é uma página só, carregada uma
      // vez. Depois de um deploy, quem já estava com a aba aberta continua
      // rodando o JS ANTIGO e jura que o recurso novo "não apareceu" — sem
      // nenhuma forma de provar quem está certo. Com o carimbo na tela, a
      // pergunta "você recarregou?" vira uma comparação de dois números.
      return json(req, res, 200, {
        status: 'ok',
        service: 'drac-central',
        time: new Date().toISOString(),
        build: buildStamp(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/ready') {
      try {
        await Promise.race([
          getDatastore().load(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('datastore_timeout')), 3_000)),
        ]);
        if (_dbGateActiveSince && Date.now() - _dbGateActiveSince > 30_000) {
          return json(req, res, 503, { status: 'not_ready', datastore: true, queueBlockedMs: Date.now() - _dbGateActiveSince });
        }
        return json(req, res, 200, { status: 'ready', datastore: true, queuedMutations: _dbGatePending });
      } catch {
        return json(req, res, 503, { status: 'not_ready', datastore: false });
      }
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      return empty(req, res, 204);
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      return handleLogin(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      return handleLogout(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      return handleMe(req, res);
    }

    // ── A INSTALAÇÃO ENVIA SUA CÓPIA DE SEGURANÇA ──────────────────────────
    //
    // Até 25/08/2026 cada instalação guardava o backup no MESMO disco dos
    // dados. Isso protege contra apagar uma tabela por engano e NÃO protege
    // contra o disco falhar — que é o que acontece em servidor rodando 24h.
    //
    // Autenticada como qualquer chamada de agente: id + chave de licença. Uma
    // instalação só pode enviar a PRÓPRIA cópia.
    if (req.method === 'POST' && url.pathname === '/api/agent/backup') {
      const installationId = String(req.headers['x-drac-installation-id'] || '').trim();
      const licenseKey = String(req.headers['x-drac-license-key'] || '').trim();
      if (!installationId || !licenseKey) return json(req, res, 401, { error: 'missing_installation_or_license' });
      const dbAg = await loadDb();
      const inst = dbAg.installations[installationId];
      if (!inst) return json(req, res, 403, { error: 'unknown_installation' });
      if (inst.licenseKey && !timingSafeTextEquals(inst.licenseKey, licenseKey)) {
        return json(req, res, 403, { error: 'invalid_license_key' });
      }
      const pedacos = [];
      let total = 0;
      let excedeu = false;
      for await (const p of req) {
        total += p.length;
        if (total > cofre.MAX_BYTES) { excedeu = true; break; }
        pedacos.push(p);
      }
      if (excedeu) return json(req, res, 413, { error: 'backup_too_large' });
      try {
        const registro = await cofre.guardar(BACKUP_DIR, installationId, Buffer.concat(pedacos), { manter: BACKUP_MANTER });
        inst.ultimoBackup = registro;
        inst.updatedAt = new Date().toISOString();
        await saveDb(dbAg);
        return json(req, res, 201, registro);
      } catch (e) {
        return json(req, res, 400, { error: 'backup_rejeitado', message: String(e.message || e) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/enroll') {
      return handleEnroll(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') {
      return handleHeartbeat(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/push/fcm') {
      return handleFcmPush(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/reactivation-archive') {
      return handleUploadReactivationArchive(req, res);
    }
    const agentArchiveMatch = url.pathname.match(/^\/api\/agent\/reactivation-archive\/([^/]+)$/);
    if (req.method === 'GET' && agentArchiveMatch) {
      return handleDownloadReactivationArchive(req, res, decodeURIComponent(agentArchiveMatch[1]));
    }
    const agentArchiveConfirmMatch = url.pathname.match(/^\/api\/agent\/reactivation-archive\/([^/]+)\/restored$/);
    if (req.method === 'POST' && agentArchiveConfirmMatch) {
      return handleConfirmReactivationRestore(req, res, decodeURIComponent(agentArchiveConfirmMatch[1]));
    }
    if (req.method === 'GET' && url.pathname === '/api/agent/status') {
      return handleAgentStatus(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/operations/claim') {
      return handleClaimOperation(req, res);
    }
    const operationResultMatch = url.pathname.match(/^\/api\/agent\/operations\/([^/]+)\/result$/);
    if (req.method === 'POST' && operationResultMatch) {
      return handleOperationResult(req, res, decodeURIComponent(operationResultMatch[1]));
    }
    const installerMatch = url.pathname.match(/^\/install\/([^/]+)$/);
    if (req.method === 'GET' && installerMatch) {
      return handleQuickInstaller(req, res, decodeURIComponent(installerMatch[1]));
    }
    if (url.pathname.startsWith('/api/admin/')) {
      const remoteInstallRequest = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/remote-install$/);
      if (req.method === 'POST' && remoteInstallRequest) {
        return handleRemoteInstall(req, res, decodeURIComponent(remoteInstallRequest[1]));
      }
      const db = await loadDb();
      const actor = getAuthenticatedUser(req, db);
      if (!actor) {
        await saveDb(db);
        return json(req, res, 401, { error: 'unauthorized' });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/installations') {
        await saveDb(db);
        return json(req, res, 200, { items: Object.values(db.installations).map((i) => publicInstallation(i, releaseAtual(db))) });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
        await saveDb(db);
        return json(req, res, 200, fleetSummary(Object.values(db.installations)));
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/provision') {
        return handleProvision(req, res, db, actor);
      }

      // ── Versão aprovada da frota ──────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/admin/releases') {
        await saveDb(db);
        return json(req, res, 200, {
          atual: releaseAtual(db),
          historico: Array.isArray(db.releaseHistorico) ? db.releaseHistorico : [],
          frota: releases.resumoDaFrota(db.installations, releaseAtual(db)),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/releases') {
        return handlePromoverRelease(req, res, db, actor);
      }

      const operationMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/operations$/);
      if (req.method === 'POST' && operationMatch) {
        return handleQueueOperation(req, res, db, actor, decodeURIComponent(operationMatch[1]));
      }

      // O documento técnico não faz parte dos assets públicos e exige sessão
      // interativa + permissão explícita. O bearer de automação administrativa
      // continua válido nas rotas operacionais, mas nunca recebe este conteúdo.
      if (req.method === 'GET' && url.pathname === '/api/admin/technical-documentation') {
        return handleTechnicalDocumentation(req, res, db, actor);
      }

      // ── Usuários da Central ────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/admin/users') {
        return handleListUsers(req, res, db);
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/users') {
        return handleUpsertUser(req, res, db, actor);
      }
      const userDelMatch = url.pathname.match(/^\/api\/admin\/users\/(.+)$/);
      if (req.method === 'DELETE' && userDelMatch) {
        return handleDeleteUser(req, res, db, actor, decodeURIComponent(userDelMatch[1]));
      }

      // ── Geração de APK (proxy para o build-agent) ──────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/admin/apk/clients') {
        await saveDb(db);
        const r = await agentFetch('/clients');
        return json(req, res, r.status, r.data);
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/apk/clients') {
        const body = await readBody(req);
        await saveDb(db);
        const r = await agentFetch('/clients', { method: 'POST', body: JSON.stringify(body) });
        addAuditEvent(db, req, { type: 'apk.client_upserted', actor: actor.email, result: r.status < 400 ? 'accepted' : 'denied', installationId: body.slug || null });
        await saveDb(db);
        return json(req, res, r.status, r.data);
      }
      const apkDeleteMatch = url.pathname.match(/^\/api\/admin\/apk\/clients\/([^/]+)$/);
      if (req.method === 'DELETE' && apkDeleteMatch) {
        const slug = decodeURIComponent(apkDeleteMatch[1]);
        const r = await agentFetch(`/clients/${encodeURIComponent(slug)}`, { method: 'DELETE' });
        // Apaga o BUILD, mas PRESERVA as preferências do usuário (nome, pacote e
        // servidor). Antes zerávamos `inst.app = null`, o que fazia o app voltar
        // ao nome padrão do cliente (ex.: "DRAC Local") ao regenerar — perdendo
        // o "Ibtelecom" que o usuário tinha definido. Agora só limpamos o estado
        // de build; effectiveAppName/PackageId/deriveClientApiUrl continuam
        // enxergando as escolhas salvas.
        for (const inst of Object.values(db.installations)) {
          if (inst.app && inst.app.slug === slug) {
            const { appName, packageId, apiUrlOverride, pushEnabled } = inst.app;
            inst.app = (appName || packageId || apiUrlOverride || pushEnabled)
              ? { appName, packageId, apiUrlOverride, pushEnabled: pushEnabled === true }
              : null;
          }
        }
        addAuditEvent(db, req, { type: 'apk.client_deleted', actor: actor.email, result: r.status < 400 ? 'accepted' : 'denied', installationId: slug });
        await saveDb(db);
        return json(req, res, r.status, r.data);
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/apk/builds') {
        await saveDb(db);
        const r = await agentFetch('/builds');
        return json(req, res, r.status, r.data);
      }
      const apkBuildMatch = url.pathname.match(/^\/api\/admin\/apk\/clients\/([^/]+)\/build$/);
      if (req.method === 'POST' && apkBuildMatch) {
        const slug = decodeURIComponent(apkBuildMatch[1]);
        const approvedRelease = releaseAtual(db);
        if (!approvedRelease?.commit) {
          return json(req, res, 409, {
            error: 'release_not_approved',
            message: 'Promova uma release testada antes de gerar o aplicativo.',
          });
        }
        // Regerar precisa ter a mesma garantia do primeiro build: o agente só
        // aceita um commit imutável que já foi aprovado pela Central.
        const r = await agentFetch('/builds', {
          method: 'POST',
          body: JSON.stringify({ slug, sourceCommit: approvedRelease.commit }),
        });
        addAuditEvent(db, req, { type: 'apk.build_started', actor: actor.email, result: r.status < 400 ? 'accepted' : 'denied', installationId: slug });
        await saveDb(db);
        return json(req, res, r.status, r.data);
      }
      // Download do APK com NOME AMIGÁVEL (nome do app), não o slug interno.
      // Reentrega o arquivo publicado em /apk com Content-Disposition.
      const apkDownloadMatch = url.pathname.match(/^\/api\/admin\/apk\/clients\/([^/]+)\/download$/);
      if (req.method === 'GET' && apkDownloadMatch) {
        const slug = decodeURIComponent(apkDownloadMatch[1]);
        const inst = db.installations[slug];
        const filename = safeApkFilename(inst ? effectiveAppName(inst) : slug);
        await saveDb(db);
        const upstream = await artifactFetch(`/apk/drac-${encodeURIComponent(slug)}.apk`);
        if (!upstream) {
          return json(req, res, 502, { error: 'artifact_source_unavailable', message: 'Servidor de arquivos temporariamente indisponível. Tente novamente em instantes.' });
        }
        if (!upstream.ok || !upstream.body) {
          return json(req, res, 404, { error: 'apk_not_found', message: 'APK ainda não gerado para este cliente.' });
        }
        const len = upstream.headers.get('content-length');
        res.writeHead(200, {
          ...securityHeaders(req),
          'content-type': 'application/vnd.android.package-archive',
          'content-disposition': `attachment; filename="${filename}"`,
          ...(len ? { 'content-length': len } : {}),
        });
        const { Readable } = require('node:stream');
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }
      // Download do AAB (App Bundle) — arquivo que sobe na Google Play Store.
      const aabDownloadMatch = url.pathname.match(/^\/api\/admin\/apk\/clients\/([^/]+)\/download-aab$/);
      if (req.method === 'GET' && aabDownloadMatch) {
        const slug = decodeURIComponent(aabDownloadMatch[1]);
        const inst = db.installations[slug];
        const base = safeApkFilename(inst ? effectiveAppName(inst) : slug).replace(/\.apk$/i, '');
        await saveDb(db);
        const upstream = await artifactFetch(`/apk/drac-${encodeURIComponent(slug)}.aab`);
        if (!upstream) {
          return json(req, res, 502, { error: 'artifact_source_unavailable', message: 'Servidor de arquivos temporariamente indisponível. Tente novamente em instantes.' });
        }
        if (!upstream.ok || !upstream.body) {
          return json(req, res, 404, { error: 'aab_not_found', message: 'AAB (Play Store) ainda não gerado. Gere/atualize o app.' });
        }
        const len = upstream.headers.get('content-length');
        res.writeHead(200, {
          ...securityHeaders(req),
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${base}.aab"`,
          ...(len ? { 'content-length': len } : {}),
        });
        const { Readable } = require('node:stream');
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }
      const kitDownloadMatch = url.pathname.match(/^\/api\/admin\/apk\/clients\/([^/]+)\/download-kit$/);
      if (req.method === 'GET' && kitDownloadMatch) {
        const slug = decodeURIComponent(kitDownloadMatch[1]);
        const inst = db.installations[slug];
        const base = safeApkFilename(inst ? effectiveAppName(inst) : slug).replace(/\.apk$/i, '');
        await saveDb(db);
        const upstream = await artifactFetch(`/apk/drac-${encodeURIComponent(slug)}-playstore-kit.zip`);
        if (!upstream) {
          return json(req, res, 502, { error: 'artifact_source_unavailable', message: 'Servidor de arquivos temporariamente indisponível. Tente novamente em instantes.' });
        }
        if (!upstream.ok || !upstream.body) {
          return json(req, res, 404, { error: 'kit_not_found', message: 'Kit Play Store ainda não gerado. Gere/atualize o app.' });
        }
        const len = upstream.headers.get('content-length');
        res.writeHead(200, {
          ...securityHeaders(req),
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${base}-playstore-kit.zip"`,
          ...(len ? { 'content-length': len } : {}),
        });
        const { Readable } = require('node:stream');
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }
      const apkBuildStatusMatch = url.pathname.match(/^\/api\/admin\/apk\/builds\/([^/]+)$/);
      if (req.method === 'GET' && apkBuildStatusMatch) {
        await saveDb(db);
        const r = await agentFetch(`/builds/${encodeURIComponent(decodeURIComponent(apkBuildStatusMatch[1]))}`);
        return json(req, res, r.status, r.data);
      }

      // ── App por cliente (auto: deriva tudo do cadastro + branding do cliente) ─
      const genAppMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/generate-app$/);
      if (req.method === 'POST' && genAppMatch) {
        return handleGenerateApp(req, res, db, actor, decodeURIComponent(genAppMatch[1]));
      }
      const instAppMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/app$/);
      if (req.method === 'GET' && instAppMatch) {
        await saveDb(db);
        return handleInstallationApp(req, res, db, decodeURIComponent(instAppMatch[1]));
      }
      if (req.method === 'PATCH' && instAppMatch) {
        return handlePatchApp(req, res, db, actor, decodeURIComponent(instAppMatch[1]));
      }

      // ── Nós de computação por instalação (item 3.2) ────────────────────────
      const cloudStorageMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/cloud-storage$/);
      if (req.method === 'PATCH' && cloudStorageMatch) {
        return handlePatchCloudStorage(req, res, db, actor, decodeURIComponent(cloudStorageMatch[1]));
      }
      if (req.method === 'DELETE' && cloudStorageMatch) {
        return handleDeleteCloudStorage(req, res, db, actor, decodeURIComponent(cloudStorageMatch[1]));
      }
      const cloudSecretMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/cloud-storage\/secret$/);
      if (req.method === 'GET' && cloudSecretMatch) {
        return handleRevealCloudStorageSecret(req, res, db, actor, decodeURIComponent(cloudSecretMatch[1]));
      }
      const cloudPerfMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/cloud-storage\/performance$/);
      if (req.method === 'POST' && cloudPerfMatch) {
        return handleCloudStoragePerformance(req, res, db, actor, decodeURIComponent(cloudPerfMatch[1]));
      }
      const cloudTestMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/cloud-storage\/test$/);
      if (req.method === 'POST' && cloudTestMatch) {
        return handleTestCloudStorage(req, res, db, actor, decodeURIComponent(cloudTestMatch[1]));
      }
      const alertasMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/alertas$/);
      if (req.method === 'PATCH' && alertasMatch) {
        return handlePatchAlertas(req, res, db, actor, decodeURIComponent(alertasMatch[1]));
      }
      const alertasTesteMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/alertas\/teste$/);
      if (req.method === 'POST' && alertasTesteMatch) {
        return handleTestarAlertas(req, res, db, actor, decodeURIComponent(alertasTesteMatch[1]));
      }
      const aiPolicyMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/ai-policy$/);
      if (req.method === 'PATCH' && aiPolicyMatch) {
        return handlePatchAiPolicy(req, res, db, actor, decodeURIComponent(aiPolicyMatch[1]));
      }

      const archiveMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/reactivation-archive$/);
      if (req.method === 'POST' && archiveMatch) {
        return handleRequestReactivationArchive(req, res, db, actor, decodeURIComponent(archiveMatch[1]));
      }
      if (req.method === 'DELETE' && archiveMatch) {
        return handleDeleteReactivationArchive(req, res, db, actor, decodeURIComponent(archiveMatch[1]));
      }
      const reactivateMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/reactivation-archive\/reactivate$/);
      if (req.method === 'POST' && reactivateMatch) {
        return handleReactivateInstallation(req, res, db, actor, decodeURIComponent(reactivateMatch[1]));
      }

      const computeNodesMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/compute-nodes$/);
      if (req.method === 'PATCH' && computeNodesMatch) {
        return handlePatchComputeNodes(req, res, db, actor, decodeURIComponent(computeNodesMatch[1]));
      }

      // ── Scheduler multi-nó (fase 4) — SÓ com a flag ligada ─────────────────
      // Com a flag off nem chegamos a testar o caminho: as rotas caem no 404
      // genérico lá embaixo, exatamente como antes desta fase existir.
      if (SCHEDULER.enabled) {
        const schedulerMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/scheduler$/);
        if (req.method === 'GET' && schedulerMatch) {
          return handleGetSchedulerPlan(req, res, db, decodeURIComponent(schedulerMatch[1]));
        }
        if (req.method === 'PATCH' && schedulerMatch) {
          return handlePatchSchedulerEnabled(req, res, db, actor, decodeURIComponent(schedulerMatch[1]));
        }
        const replanMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/scheduler\/replan$/);
        if (req.method === 'POST' && replanMatch) {
          return handleSchedulerReplan(req, res, db, actor, decodeURIComponent(replanMatch[1]));
        }
      }

      // ── Instalação remota via SSH ──────────────────────────────────────────
      const remoteInstallStatusMatch = url.pathname.match(/^\/api\/admin\/remote-installs\/([^/]+)$/);
      if (req.method === 'GET' && remoteInstallStatusMatch) {
        await saveDb(db);
        const job = remoteInstalls.get(decodeURIComponent(remoteInstallStatusMatch[1]));
        if (!job) return json(req, res, 404, { error: 'job_not_found' });
        return json(req, res, 200, publicRemoteInstall(job));
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/audit') {
        await saveDb(db);
        const events = Array.isArray(db.auditEvents) ? db.auditEvents.slice().reverse().slice(0, 200) : [];
        return json(req, res, 200, { items: events });
      }
      const detailMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)$/);
      if (req.method === 'GET' && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const item = db.installations[id];
        await saveDb(db);
        if (!item) return json(req, res, 404, { error: 'installation_not_found' });
        return json(req, res, 200, publicInstallation(item));
      }
      if (req.method === 'DELETE' && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const item = db.installations[id];
        // ── REMOVER INSTALAÇÃO, INCLUSIVE ATIVA ─────────────────────────────
        //
        // "não deve ter instalação sem central" (dono, 24/08/2026). Antes só
        // dava para cancelar provisionamento pendente, e cliente que saía
        // ficava para sempre na frota — a `dguardian` era o caso.
        //
        // Não apagamos NADA na máquina do cliente: quem faz o serviço parar é a
        // licença. Sem registro aqui, ela restringe em 10 dias e suspende em 15.
        const decisao = decidirRemocao({ existente: item, confirmacao: url.searchParams.get('confirmar') });
        if (!decisao.permitido) {
          const mensagens = {
            'nao-encontrada': 'Instalação não encontrada.',
            'confirmacao-invalida': 'Para remover uma instalação ATIVA, confirme digitando o código dela.',
          };
          return json(req, res, decisao.http, {
            error: decisao.motivo,
            message: mensagens[decisao.motivo] || 'Não foi possível remover.',
          });
        }
        delete db.installations[id];
        addAuditEvent(db, req, {
          type: decisao.motivo === 'remover-ativa' ? 'installation.removed' : 'installation.provision_deleted',
          actor: actor.email,
          result: 'accepted',
          installationId: id,
        });
        await saveDb(db);
        // Sem Postgres é no-op; com Postgres evita série órfã de uma instalação
        // que deixou de existir.
        await withTimeseries((store) => store.purgeInstallation(id), 'purge');
        return json(req, res, 200, { ok: true });
      }

      // ── VPN DA INSTALAÇÃO ──────────────────────────────────────────────
      //
      // O túnel serve para a instalação alcançar as CÂMERAS do cliente quando
      // o servidor não está dentro da rede dele. Não tem relação com o contato
      // instalação↔Central, que é HTTPS comum.
      //
      // Segredos entram cifrados e NUNCA voltam na leitura — o painel só sabe
      // se existem.
      const vpnMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/vpn$/);
      if (vpnMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
        const id = decodeURIComponent(vpnMatch[1]);
        const item = db.installations[id];
        if (!item) return json(req, res, 404, { error: 'installation_not_found' });

        if (req.method === 'DELETE') {
          delete item.vpn;
          item.updatedAt = new Date().toISOString();
          addAuditEvent(db, req, { type: 'installation.vpn_removed', actor: actor.email, result: 'accepted', installationId: id });
          await saveDb(db);
          return json(req, res, 200, { ok: true, vpn: null });
        }

        const body = await readBody(req);
        // Faixas de OUTRAS instalações não entram na conta: cada instalação é
        // um servidor próprio. O conflito que importa é entre túneis do MESMO
        // servidor, e hoje é um por instalação.
        const validado = validarPerfilDeVpn(body, []);
        if (!validado.ok) {
          return json(req, res, 400, { error: validado.motivo, detalhe: validado.detalhe || null });
        }
        const anterior = item.vpn || {};
        item.vpn = {
          ...validado.perfil,
          // Segredo em branco MANTÉM o que já existe: reeditar o formulário
          // sem redigitar a senha não pode apagar a senha.
          senhaCifrada: body.senha ? cifrarSegredo(String(body.senha), SECRET_KEY) : (anterior.senhaCifrada || null),
          segredoCifrado: body.segredo ? cifrarSegredo(String(body.segredo), SECRET_KEY) : (anterior.segredoCifrado || null),
          revisao: (Number(anterior.revisao) || 0) + 1,
        };
        item.updatedAt = new Date().toISOString();
        addAuditEvent(db, req, { type: 'installation.vpn_configured', actor: actor.email, result: 'accepted', installationId: id });
        await saveDb(db);
        return json(req, res, 200, { ok: true, vpn: perfilParaPainel(item.vpn) });
      }

      // ── CÓPIAS DE SEGURANÇA DE UMA INSTALAÇÃO ──────────────────────────
      const backupListMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/backups$/);
      if (req.method === 'GET' && backupListMatch) {
        const id = decodeURIComponent(backupListMatch[1]);
        if (!db.installations[id]) return json(req, res, 404, { error: 'installation_not_found' });
        return json(req, res, 200, { items: await cofre.listar(BACKUP_DIR, id), manter: BACKUP_MANTER });
      }
      const backupFileMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/backups\/([^/]+)$/);
      if (req.method === 'GET' && backupFileMatch) {
        const id = decodeURIComponent(backupFileMatch[1]);
        const nome = decodeURIComponent(backupFileMatch[2]);
        if (!db.installations[id]) return json(req, res, 404, { error: 'installation_not_found' });
        let caminho;
        try { caminho = cofre.caminhoDe(BACKUP_DIR, id, nome); }
        catch { return json(req, res, 400, { error: 'nome_invalido' }); }
        if (!fsSync.existsSync(caminho)) return json(req, res, 404, { error: 'backup_not_found' });
        addAuditEvent(db, req, { type: 'installation.backup_downloaded', actor: actor.email, result: 'accepted', installationId: id });
        await saveDb(db);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${id}-${nome}"`,
        });
        return fsSync.createReadStream(caminho).pipe(res);
      }
      const installerCommandMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/installer$/);
      if (req.method === 'GET' && installerCommandMatch) {
        return handleGetInstallerCommand(req, res, db, actor, decodeURIComponent(installerCommandMatch[1]));
      }
      // ── Série temporal (histórico real para gráfico) ───────────────────────
      if (req.method === 'GET' && url.pathname === '/api/admin/fleet/timeseries') {
        return handleFleetTimeseries(req, res, db, url);
      }
      const timeseriesMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/timeseries$/);
      if (req.method === 'GET' && timeseriesMatch) {
        return handleInstallationTimeseries(req, res, db, url, decodeURIComponent(timeseriesMatch[1]));
      }
      const diagnosticsMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/diagnostics$/);
      if (req.method === 'GET' && diagnosticsMatch) {
        const id = decodeURIComponent(diagnosticsMatch[1]);
        const item = db.installations[id];
        if (!item) return json(req, res, 404, { error: 'installation_not_found' });
        addAuditEvent(db, req, {
          type: 'installation.diagnostics_viewed',
          actor: actor.email,
          result: 'accepted',
          installationId: id,
        });
        await saveDb(db);
        return json(req, res, 200, supportDiagnostics(item));
      }
      const match = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/license$/);
      if (req.method === 'PATCH' && match) {
        const id = decodeURIComponent(match[1]);
        const body = await readBody(req);
        const item = db.installations[id];
        if (!item) return json(req, res, 404, { error: 'installation_not_found' });
        const allowed = ['ACTIVE', 'GRACE', 'RESTRICTED', 'SUSPENDED'];
        if (!allowed.includes(body.licenseStatus)) {
          return json(req, res, 400, { error: 'invalid_license_status' });
        }
        const licenseHistory = Array.isArray(item.licenseHistory) ? item.licenseHistory : [];
        if (item.licenseStatus !== body.licenseStatus || (item.licenseMessage || null) !== (body.licenseMessage || null)) {
          licenseHistory.push({
            at: new Date().toISOString(),
            from: item.licenseStatus || LICENSE_ACTIVE,
            to: body.licenseStatus,
            message: body.licenseMessage || null,
            by: actor.email,
          });
        }
        while (licenseHistory.length > 100) licenseHistory.shift();
        item.licenseStatus = body.licenseStatus;
        item.licenseMessage = body.licenseMessage || null;
        item.licenseHistory = licenseHistory;
        // ── TETO DE CÂMERAS CONTRATADO ────────────────────────────────────
        //
        // "se dguardian dizer que vai pagar apenas para 50 cameras, eu tenho
        //  que limitar pela central" (dono, 24/08/2026)
        //
        // Vazio/null = SEM teto. Nunca inventamos um número: campo em branco
        // travando o cadastro de quem pagou por mais seria pior que cobrar de
        // menos. Zero é teto de verdade, e só existe se alguém escrever zero.
        if (Object.prototype.hasOwnProperty.call(body, 'maxCameras')) {
          const r = normalizarTeto(body.maxCameras);
          if (!r.ok) return json(req, res, 400, { error: 'invalid_max_cameras' });
          item.maxCameras = r.valor;
        }
        for (const field of ['maxUsers', 'maxRetentionDays']) {
          if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
          const r = normalizarTeto(body[field]);
          if (!r.ok) return json(req, res, 400, { error: `invalid_${field}` });
          item[field] = r.valor;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'licensePlan')) {
          item.licensePlan = normalizePlan(body.licensePlan);
        }
        item.updatedAt = new Date().toISOString();
        addAuditEvent(db, req, {
          type: 'installation.license_changed',
          actor: actor.email,
          result: 'accepted',
          installationId: id,
          from: licenseHistory.at(-1)?.from || item.licenseStatus || LICENSE_ACTIVE,
          to: body.licenseStatus,
        });
        await saveDb(db);
        return json(req, res, 200, publicInstallation(item));
      }
      return json(req, res, 404, { error: 'not_found' });
    }
    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    const statusCode = Number(error?.statusCode) || 500;
    return json(req, res, statusCode, {
      error: statusCode === 413 ? 'payload_too_large' : 'internal_error',
      message: statusCode === 413 ? error.message : 'Falha interna no servidor.',
    });
  }
}

// Guardas globais: um erro solto (ex.: handler chamado sem await) NUNCA deve
// derrubar o processo — antes virava crash loop e tirava a Central do ar.
process.on('uncaughtException', (error) => {
  console.error('[central] uncaughtException:', error && error.stack ? error.stack : error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[central] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});

// Serialização das rotas que tocam o banco. loadDb()/saveDb() fazem
// read-modify-write do arquivo inteiro SEM lock; requests concorrentes (ex.: um
// heartbeat chegando no meio de uma edição do app) se sobrescreviam — o nome do
// app definido pelo usuário voltava ao padrão ("DRAC Local"), e saveDb atômico
// batia `ENOENT` no rename por gravar `.tmp` concorrente. Como o painel é de
// baixo tráfego e o Node é single-thread, serializar essas rotas elimina a
// corrida sem custo perceptível. Estáticos (não tocam o DB) seguem em paralelo.
let _dbGate = Promise.resolve();
let _dbGatePending = 0;
let _dbGateActiveSince = 0;
const MAX_DB_GATE_PENDING = Math.max(10, Number(process.env.DRAC_CENTRAL_MAX_DB_QUEUE || 500));
function runSerialized(task) {
  _dbGatePending += 1;
  const wrapped = async () => {
    _dbGateActiveSince = Date.now();
    try { return await task(); } finally {
      _dbGatePending -= 1;
      _dbGateActiveSince = 0;
    }
  };
  const p = _dbGate.then(wrapped, wrapped);
  _dbGate = p.then(() => {}, () => {});
  return p;
}

// Poda/rollup periódicos da série temporal: sem isso a tabela de amostras cresce
// para sempre. Só liga quando há Postgres (no DEFAULT devolve null e nenhum timer
// é criado). `unref()` para o timer nunca segurar o processo de pé.
function startTimeseriesMaintenance() {
  const store = getTimeseries();
  if (!store || !store.enabled) return null;
  const intervalMs = Math.max(60 * 1000, Number(store.maintenanceIntervalMs) || 30 * 60 * 1000);
  const run = () => {
    withTimeseries(async (s) => {
      const result = await s.maintain({ now: new Date() });
      if (result && (result.rolledUpSamples || result.hourlyDeleted)) {
        console.log(`[central] rollup da série temporal: ${result.rolledUpSamples} amostras → ${result.buckets} buckets horários; ${result.hourlyDeleted} buckets expirados removidos.`);
      }
      return result;
    }, 'maintain');
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  run();
  return timer;
}

/**
 * VARREDURA DOS ARQUIVOS DE REATIVAÇÃO VENCIDOS.
 *
 * A política de privacidade publicada promete apagar o arquivo do cliente
 * cancelado em 24 meses. Até 17/08/2026 essa promessa NÃO era cumprida: o
 * vencimento era calculado e gravado, e nada varria o diretório — o arquivo
 * cifrado ficaria no disco para sempre. Promessa de privacidade escrita e não
 * cumprida é pior que promessa não feita.
 *
 * O registro na auditoria PERMANECE depois da exclusão: quem apagou o quê e
 * quando é justamente o que se apresenta numa fiscalização. Some o dado, fica
 * a prova de que ele foi eliminado no prazo.
 *
 * A decisão de "venceu" mora em expiracao-de-arquivo.js, com teste — errar
 * essa conta apaga o arquivo de quem ainda podia recontratar.
 */
async function varrerArquivosVencidos() {
  const db = await loadDb();
  const instalacoes = Object.entries(db.installations || {}).map(([id, item]) => ({ id, ...item }));
  const vencidos = selecionarVencidos(instalacoes, new Date());
  if (!vencidos.length) return { apagados: 0 };

  let apagados = 0;
  for (const alvo of vencidos) {
    const item = db.installations[alvo.installationId];
    if (!item) continue;
    try {
      await reactivationArchiveStore().delete(alvo.installationId);
    } catch (erro) {
      // Arquivo já ausente do disco não impede fechar o registro: o objetivo é
      // que ele não exista, e ele não existe.
      console.warn(`[central] arquivo de ${alvo.installationId} já não estava no disco: ${erro && erro.message}`);
    }
    item.reactivationArchive = {
      ...item.reactivationArchive,
      state: 'DELETED',
      deletedAt: new Date().toISOString(),
      deletedReason: 'RETENTION_EXPIRED',
    };
    item.updatedAt = new Date().toISOString();
    addAuditEvent(db, null, {
      type: 'installation.reactivation_archive_expired',
      actor: 'sistema',
      result: 'deleted',
      installationId: alvo.installationId,
      expiresAt: alvo.expiresAt,
    });
    apagados += 1;
  }
  await saveDb(db);
  console.log(`[central] retenção: ${apagados} arquivo(s) de reativação vencido(s) apagado(s).`);
  return { apagados };
}

/** Roda de hora em hora. `unref()` para o timer nunca segurar o processo. */
function startArquivoRetentionSweep() {
  const intervalMs = Math.max(
    5 * 60 * 1000,
    Number(process.env.DRAC_CENTRAL_ARCHIVE_SWEEP_MS) || 60 * 60 * 1000,
  );
  const run = () => {
    varrerArquivosVencidos().catch((erro) => {
      // Falha aqui NÃO pode derrubar a Central: é limpeza, e a próxima volta
      // tenta de novo.
      console.warn(`[central] varredura de arquivos vencidos falhou: ${erro && erro.message}`);
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  run();
  return timer;
}

function startServer() {
  const server = http.createServer((req, res) => {
  // route() é async; sem este .catch, uma rejeição (ex.: loadDb) escapava como
  // unhandledRejection. Aqui garantimos uma resposta 500 e seguimos vivos.
  const url = req.url || '';
  // ── O PORTÃO NÃO PODE ENGOLIR ROTA LONGA ────────────────────────────────
  //
  // `runSerialized` envolve a PROMESSA INTEIRA da rota, e ele existe por um
  // motivo legítimo: o datastore JSON faz read-modify-write sem lock, então
  // duas edições concorrentes se sobrescrevem.
  //
  // Só que duas rotas medem coisas do mundo real e duram MINUTOS: o teste de
  // desempenho do storage (teto de 30 min, escolhendo 256 MB num link lento) e
  // o provisionamento remoto por SSH. Dentro do portão, elas param TODO
  // `/api/*` atrás de si — inclusive o heartbeat de todas as instalações. Com
  // o limiar de 180s, a frota inteira aparece OFFLINE na tela e as instalações
  // registram falha de comunicação, por causa de um clique em "Desempenho".
  //
  // Elas passam a rodar FORA do portão; a parte que toca o banco (o evento de
  // auditoria + saveDb) continua serializada dentro do próprio handler, que é
  // o único trecho onde a corrida existe de verdade.
  const rotaLonga = /^\/api\/admin\/installations\/[^/]+\/(cloud-storage\/performance|remote-install)/.test(url);
  const touchesDb =
    !rotaLonga
    && ((url.startsWith('/api/') && !['/api/health', '/api/ready'].includes(url)) || url.startsWith('/install/'));
  const run = () => Promise.resolve(route(req, res));
  const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '');
  const prepared = touchesDb && hasBody ? readBody(req) : Promise.resolve();
  const started = prepared.then(() => {
    if (touchesDb && _dbGatePending >= MAX_DB_GATE_PENDING) {
      return json(req, res, 503, { error: 'central_busy', queuedMutations: _dbGatePending });
    }
    return touchesDb ? runSerialized(run) : run();
  });
  started.catch((error) => {
    console.error('[central] erro não tratado na rota:', error && error.stack ? error.stack : error);
    try {
      const statusCode = Number(error?.statusCode) || 500;
      if (!res.headersSent) json(req, res, statusCode, {
        error: statusCode === 408 ? 'request_timeout' : statusCode === 413 ? 'payload_too_large' : statusCode === 400 ? 'invalid_json' : 'internal_error',
      });
      else res.end();
    } catch { /* resposta já encerrada */ }
  });
  });
  const datastore = getDatastore();
  Promise.resolve(datastore.acquireInstanceLock())
    .then(() => {
      startTimeseriesMaintenance();
  startArquivoRetentionSweep();
      startReactivationArchiveMaintenance();
      startConnectivityMonitor();
      server.listen(PORT, HOST, () => {
        console.log(`DRAC Central ouvindo em http://${HOST}:${PORT}`);
      });
    })
    .catch((error) => {
      console.error('[central] startup recusado:', error.message);
      server.emit('error', error);
    });

  let closing = false;
  let datastoreClosePromise = null;
  const closeDatastore = () => {
    if (!datastoreClosePromise) {
      datastoreClosePromise = datastore.close().catch((error) => {
        console.error('[central] falha ao liberar datastore:', error.message);
      });
    }
    return datastoreClosePromise;
  };
  server.on('close', () => { void closeDatastore(); });
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[central] ${signal}: encerrando com segurança.`);
    server.close(() => {
      closeDatastore().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  server.once('listening', () => {
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
  return server;
}

if (require.main === module) startServer();

module.exports = {
  hashPassword,
  isStrongPassword,
  normalizeDb,
  parseDbText,
  publicInstallation,
  fleetSummary,
  heartbeatCameraBlock,
  heartbeatCameraRaw,
  updateAlertHistory,
  updateConnectivityAlert,
  runSerialized,
  startServer,
  startConnectivityMonitor,
  startTimeseriesMaintenance,
  verifyPassword,
  addrToApiUrl,
};
