'use strict';

/**
 * ALERTAS POR INSTALAÇÃO — para quem avisar quando algo quebra.
 *
 * O que já existia: a instalação manda seus alertas no heartbeat, a Central
 * monta um histórico ACTIVE/RESOLVED e desenha na tela. Só isso. Quem não
 * estivesse com o painel aberto não ficava sabendo de nada — e o painel de
 * uma central de monitoramento não fica aberto de madrugada.
 *
 * Havia um alerta por Telegram, mas era do WATCHDOG DE UMA MÁQUINA
 * (scripts/runtime-watchdog.sh), com o destino cozido no .env do servidor.
 * Não servia para uma frota: cada cliente precisa avisar gente diferente.
 *
 * Duas decisões que orientam o módulo:
 *
 * 1. O TOKEN DO BOT É SEGREDO e é cifrado igual à chave do S3 (AES-256-GCM,
 *    `CENTRAL_STORAGE_SECRET`). Quem tem o token manda mensagem como o bot —
 *    tratar como campo comum seria vazá-lo em toda leitura do painel.
 *
 * 2. O REMETENTE DE E-MAIL É DA CENTRAL, o destinatário é da instalação. Não
 *    faz sentido pedir uma conta SMTP por cliente; faz sentido cada cliente
 *    dizer para qual caixa avisar. Sem SMTP configurado na Central, o canal de
 *    e-mail se declara indisponível em vez de falhar calado.
 */

const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');

const LIMITE_EMAILS = 5;
const TEMPO_LIMITE_MS = 10_000;

const CONFIG_PADRAO = Object.freeze({
  emailEnabled: false,
  emails: [],
  telegramEnabled: false,
  telegramChatId: '',
  telegramBotTokenEncrypted: '',
  botSource: 'installation',
  audience: 'customer',
  cameraDelayMinutes: 10,
  serverDelayMinutes: 10,
  categories: ['camera', 'server', 'disk', 'recording'],
  // Alerta de recuperação avisa que voltou ao normal. Nasce LIGADO: sem ele o
  // operador fica sem saber se o problema passou, e continua acordado.
  avisarRecuperacao: true,
  updatedAt: null,
  ultimoTesteAt: null,
  ultimoTesteOk: null,
  ultimoTesteMensagem: '',
});

// ── Segredo ─────────────────────────────────────────────────────────────────

function chaveDeCifra() {
  const raw = String(process.env.CENTRAL_STORAGE_SECRET || '');
  if (raw.length < 16) {
    // Mesma postura do cloud-storage: falhar alto é melhor que cifrar com chave
    // fraca e passar a impressão de que o token do cliente está protegido.
    throw new Error('CENTRAL_STORAGE_SECRET é obrigatório (mínimo 16 caracteres) para guardar o token do bot.');
  }
  return createHash('sha256').update(raw).digest();
}

function cifrar(plain) {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', chaveDeCifra(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decifrar(payload) {
  if (!payload) return '';
  const raw = Buffer.from(String(payload), 'base64');
  if (raw.length <= 28) return '';
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', chaveDeCifra(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// ── Normalização ────────────────────────────────────────────────────────────

function lerBool(valor, padrao) {
  if (typeof valor === 'boolean') return valor;
  if (valor === 'true') return true;
  if (valor === 'false') return false;
  return padrao;
}

/** Validação deliberadamente frouxa: recusar endereço válido por regex estrita
 *  é pior que aceitar um errado, que o teste de envio revela na hora. */
function emailPlausivel(valor) {
  const texto = String(valor ?? '').trim();
  return texto.length >= 5 && texto.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto);
}

function normalizarAlertas(entrada) {
  const fonte = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {};
  const emails = Array.isArray(fonte.emails)
    ? [...new Set(fonte.emails.map((e) => String(e ?? '').trim().toLowerCase()).filter(emailPlausivel))].slice(0, LIMITE_EMAILS)
    : [];
  return {
    // Canal só fica ligado se HOUVER destino. Sem isto, o painel exibiria
    // "e-mail ativo" sem nenhum endereço — o pior tipo de mentira num sistema
    // de alerta, porque só se descobre quando o alerta não chega.
    emailEnabled: lerBool(fonte.emailEnabled, CONFIG_PADRAO.emailEnabled) && emails.length > 0,
    emails,
    telegramEnabled:
      lerBool(fonte.telegramEnabled, CONFIG_PADRAO.telegramEnabled)
      && Boolean(String(fonte.telegramChatId ?? '').trim())
      && Boolean(fonte.botSource === 'central' ? process.env.CENTRAL_TELEGRAM_BOT_TOKEN : String(fonte.telegramBotTokenEncrypted ?? '').trim()),
    telegramChatId: String(fonte.telegramChatId ?? '').trim().slice(0, 64),
    telegramBotTokenEncrypted: String(fonte.telegramBotTokenEncrypted ?? ''),
    botSource: fonte.botSource === 'central' ? 'central' : 'installation',
    audience: fonte.audience === 'technical' ? 'technical' : 'customer',
    cameraDelayMinutes: delayMinutes(fonte.cameraDelayMinutes),
    serverDelayMinutes: delayMinutes(fonte.serverDelayMinutes),
    categories: Array.isArray(fonte.categories) ? [...new Set(fonte.categories.filter(x => ['camera','server','disk','recording'].includes(x)))] : CONFIG_PADRAO.categories.slice(),
    avisarRecuperacao: lerBool(fonte.avisarRecuperacao, CONFIG_PADRAO.avisarRecuperacao),
    updatedAt: fonte.updatedAt ?? null,
    // O selo do teste é emitido pelo SERVIDOR, nunca aceito do corpo — mesma
    // lição do cloud-storage, onde um chamador podia mandar `lastTestOk: true`
    // e a Central exibia "OK" sobre um canal que ninguém tocou.
    ultimoTesteAt: fonte.ultimoTesteAt ?? null,
    ultimoTesteOk: typeof fonte.ultimoTesteOk === 'boolean' ? fonte.ultimoTesteOk : null,
    ultimoTesteMensagem: String(fonte.ultimoTesteMensagem ?? '').slice(0, 300),
  };
}

function delayMinutes(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : 10;
}

/** O que pode ir para o navegador: token JAMAIS sai, nem cifrado. */
function alertasPublicos(config) {
  const c = normalizarAlertas(config);
  return {
    emailEnabled: c.emailEnabled,
    emails: c.emails,
    telegramEnabled: c.telegramEnabled,
    telegramChatId: c.telegramChatId,
    telegramTokenConfigurado: Boolean(c.telegramBotTokenEncrypted),
    centralBotAvailable: Boolean(process.env.CENTRAL_TELEGRAM_BOT_TOKEN),
    botSource: c.botSource,
    audience: c.audience,
    cameraDelayMinutes: c.cameraDelayMinutes,
    serverDelayMinutes: c.serverDelayMinutes,
    categories: c.categories,
    avisarRecuperacao: c.avisarRecuperacao,
    updatedAt: c.updatedAt,
    ultimoTesteAt: c.ultimoTesteAt,
    ultimoTesteOk: c.ultimoTesteOk,
    ultimoTesteMensagem: c.ultimoTesteMensagem,
    emailDisponivel: smtpConfigurado(),
  };
}

/**
 * Mescla o que veio do formulário sobre o que já existe.
 *
 * O token só é reescrito quando o operador digita um novo. Sem essa regra,
 * salvar qualquer outro campo (trocar um e-mail, ligar o aviso de recuperação)
 * apagaria o token — o formulário nunca o recebe de volta, então ele chegaria
 * vazio no salvamento seguinte.
 */
function mesclarAlertas(atual, patch) {
  const base = normalizarAlertas(atual);
  const p = patch && typeof patch === 'object' ? patch : {};
  const tokenNovo = String(p.telegramBotToken ?? '').trim();

  return normalizarAlertas({
    ...base,
    ...(p.emails !== undefined ? { emails: p.emails } : {}),
    ...(p.emailEnabled !== undefined ? { emailEnabled: p.emailEnabled } : {}),
    ...(p.telegramChatId !== undefined ? { telegramChatId: p.telegramChatId } : {}),
    ...(p.telegramEnabled !== undefined ? { telegramEnabled: p.telegramEnabled } : {}),
    ...(p.avisarRecuperacao !== undefined ? { avisarRecuperacao: p.avisarRecuperacao } : {}),
    ...Object.fromEntries(['botSource','audience','cameraDelayMinutes','serverDelayMinutes','categories'].filter(k => p[k] !== undefined).map(k => [k,p[k]])),
    ...(tokenNovo ? { telegramBotTokenEncrypted: cifrar(tokenNovo) } : {}),
    // Apagar o token é uma ação EXPLÍCITA, não um efeito de salvar vazio.
    ...(p.limparTelegramToken === true ? { telegramBotTokenEncrypted: '' } : {}),
    updatedAt: new Date().toISOString(),
  });
}

// ── Envio: Telegram ─────────────────────────────────────────────────────────

async function enviarTelegram(config, texto) {
  let token;
  try { token = config.botSource === 'central' ? process.env.CENTRAL_TELEGRAM_BOT_TOKEN : decifrar(config.telegramBotTokenEncrypted); }
  catch { return { ok: false, permanent: true, erro: 'Não foi possível acessar a configuração do bot. Cadastre o token novamente.' }; }
  if (!token || !config.telegramChatId) return { ok: false, permanent: true, erro: 'Telegram não configurado.' };

  const controle = new AbortController();
  const corte = setTimeout(() => controle.abort(), TEMPO_LIMITE_MS);
  try {
    const resposta = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text: texto, parse_mode: 'HTML' }),
      signal: controle.signal,
    });
    const corpo = await resposta.json().catch(() => null);
    if (resposta.ok && corpo?.ok === true) return { ok: true };
    // A resposta do Telegram diz o que houve ("chat not found", "bot was
    // blocked") — é a informação que resolve o problema do operador. Mas ela
    // pode ecoar o corpo enviado, então o token nunca entra na URL de log.
    const code = Number(corpo?.error_code || resposta.status);
    const retryAfter = Number(corpo?.parameters?.retry_after);
    const detalhe = code === 401 ? 'O token do bot não é válido. Confira o cadastro.'
      : code === 403 ? 'O bot não tem permissão para enviar ao destino. Confira o grupo ou desbloqueie o bot.'
      : code === 400 ? 'Confira o destino e se o bot foi adicionado ao grupo.'
      : code === 429 ? 'O Telegram pediu uma pausa. O envio será tentado novamente.'
      : 'O Telegram não confirmou o envio. O sistema tentará novamente.';
    return { ok: false, permanent: [400,401,403,404].includes(code), retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(86400,retryAfter) : undefined, erro: detalhe };
  } catch (erro) {
    return { ok: false, erro: erro?.name === 'AbortError' ? 'Telegram não respondeu a tempo.' : 'Não foi possível acessar o Telegram. O envio será tentado novamente.' };
  } finally {
    clearTimeout(corte);
  }
}

// ── Envio: e-mail ───────────────────────────────────────────────────────────

function smtpConfigurado() {
  const cfg = configSmtp();
  return Boolean(
    cfg.host
    && Number.isInteger(cfg.port)
    && cfg.port >= 1
    && cfg.port <= 65_535
    && emailPlausivel(cfg.from)
    && (!cfg.user || cfg.pass),
  );
}

function configSmtp() {
  return {
    host: String(process.env.CENTRAL_SMTP_HOST || '').trim(),
    port: Number(process.env.CENTRAL_SMTP_PORT || 587),
    secure: String(process.env.CENTRAL_SMTP_SECURE || '') === 'true',
    user: String(process.env.CENTRAL_SMTP_USER || '').trim(),
    pass: String(process.env.CENTRAL_SMTP_PASS || ''),
    from: String(process.env.CENTRAL_SMTP_FROM || process.env.CENTRAL_SMTP_USER || '').trim(),
  };
}

/**
 * Cliente SMTP mínimo, escrito à mão.
 *
 * Por que não uma biblioteca: a Central tem HOJE duas dependências (`pg` e
 * `ssh2`) e é o painel que administra a frota inteira. Puxar uma árvore de
 * pacotes nova para mandar uma mensagem de texto aumenta a superfície de
 * atualização de um alvo sensível. O que precisamos é o caminho feliz do SMTP
 * — EHLO, STARTTLS, AUTH LOGIN, MAIL/RCPT/DATA — e ele cabe aqui, legível.
 *
 * Não pretende ser um servidor de e-mail: sem anexo, sem retentativa, sem
 * fila. Falhou, reporta e o alerta segue pelo Telegram.
 */
function falarSmtp(socket, comando, esperado) {
  if(socket.destroyed)return Promise.reject(new Error('SMTP_CONNECTION_CLOSED'));
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup=()=>{clearTimeout(timer);socket.removeListener('data',aoReceber);socket.removeListener('error',failed);socket.removeListener('close',closed);};
    const failed=()=>{cleanup();reject(new Error('SMTP_CONNECTION_FAILED'));};
    const closed=()=>{cleanup();reject(new Error('SMTP_CONNECTION_CLOSED'));};
    const timer=setTimeout(()=>{cleanup();socket.destroy();reject(new Error('SMTP_TIMEOUT'));},TEMPO_LIMITE_MS);
    const aoReceber = (chunk) => {
      buffer += chunk.toString('utf8');
      // Resposta SMTP termina em "NNN <espaço>"; com hífen ("NNN-") ainda vem mais.
      const linhas = buffer.split('\r\n').filter(Boolean);
      const ultima = linhas[linhas.length - 1];
      if (!ultima || !/^\d{3} /.test(ultima)) return;
      cleanup();
      const codigo = Number(ultima.slice(0, 3));
      if (esperado.includes(codigo)) resolve(buffer);
      else reject(new Error(`SMTP_${codigo}`));
    };
    socket.on('data', aoReceber);
    socket.once('error',failed);socket.once('close',closed);
    if (comando !== null) socket.write(`${comando}\r\n`);
  });
}

async function enviarEmail(destinatarios, assunto, corpo) {
  if (!smtpConfigurado()) {
    return {
      ok: false,
      erro: 'A conta de e-mail da Central está incompleta. Verifique servidor, remetente e credenciais.',
    };
  }
  if (!destinatarios.length) return { ok: false, erro: 'Nenhum destinatário.' };

  const cfg = configSmtp();
  const assuntoSeguro = String(assunto ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
  let socket;
  const deadline=setTimeout(()=>socket?.destroy(),30000);
  try {
    socket = await new Promise((resolve, reject) => {
      const conectar = cfg.secure ? tls.connect : net.connect;
      const s = conectar({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(s));
      s.setTimeout(TEMPO_LIMITE_MS, () => { s.destroy(); reject(new Error('Servidor de e-mail não respondeu a tempo.')); });
      s.once('error', reject);
    });

    await falarSmtp(socket, null, [220]);
    await falarSmtp(socket, 'EHLO ajustcam-central', [250]);

    if (!cfg.secure) {
      // Porta 587 exige subir para TLS antes de mandar senha. Sem isto a
      // credencial iria em claro pela rede.
      await falarSmtp(socket, 'STARTTLS', [220]);
      socket = await new Promise((resolve, reject) => {
        const timer=setTimeout(()=>{seguro.destroy();reject(new Error('SMTP_TIMEOUT'));},TEMPO_LIMITE_MS);
        const seguro = tls.connect({ socket, servername: cfg.host }, () => {clearTimeout(timer);resolve(seguro);});
        seguro.once('error', error=>{clearTimeout(timer);reject(error);});
      });
      await falarSmtp(socket, 'EHLO ajustcam-central', [250]);
    }

    if (cfg.user) {
      await falarSmtp(socket, 'AUTH LOGIN', [334]);
      await falarSmtp(socket, Buffer.from(cfg.user).toString('base64'), [334]);
      await falarSmtp(socket, Buffer.from(cfg.pass).toString('base64'), [235]);
    }

    await falarSmtp(socket, `MAIL FROM:<${cfg.from}>`, [250]);
    for (const destino of destinatarios) {
      await falarSmtp(socket, `RCPT TO:<${destino}>`, [250, 251]);
    }
    await falarSmtp(socket, 'DATA', [354]);

    const cabecalho = [
      `From: AjustCam Central <${cfg.from}>`,
      `To: ${destinatarios.join(', ')}`,
      `Subject: =?UTF-8?B?${Buffer.from(assuntoSeguro).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(corpo).toString('base64').replace(/(.{76})/g, '$1\r\n'),
    ].join('\r\n');

    await falarSmtp(socket, `${cabecalho}\r\n.`, [250]);
    socket.write('QUIT\r\n');
    socket.end();
    return { ok: true };
  } catch (erro) {
    try { socket?.destroy(); } catch { /* já morto */ }
    const permanent = /^SMTP_5\d\d$/.test(String(erro?.message));
    return { ok: false, permanent, erro: permanent ? 'O envio por e-mail foi recusado. Confira a conta e os destinatários cadastrados.' : 'Não foi possível confirmar o envio por e-mail. O sistema tentará novamente.' };
  } finally {
    clearTimeout(deadline);
  }
}

// ── Mensagem ────────────────────────────────────────────────────────────────

const ESCAPE_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escaparTelegram = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ESCAPE_HTML[c]);

const primeiroNumero = (texto, fallback = 0) => {
  const encontrado = String(texto ?? '').match(/\d+(?:[.,]\d+)?/);
  return encontrado ? Number(encontrado[0].replace(',', '.')) : fallback;
};

const quantidade = (valor, singular, plural = `${singular}s`) =>
  `${valor} ${Number(valor) === 1 ? singular : plural}`;

const ROTULOS_SERVICO = Object.freeze({
  api: 'serviço principal',
  web: 'página do sistema',
  postgres: 'banco de dados',
  redis: 'serviço de filas',
  mediamtx: 'serviço de vídeo ao vivo',
  go2rtc: 'serviço de compatibilidade de vídeo',
  'rtmp-ingest': 'recebimento de vídeo das câmeras',
  'postgres-backup': 'serviço de backup do banco de dados',
  'postgres-backup-verify': 'verificação dos backups do banco de dados',
  central: 'comunicação com a Central',
  'ai-service': 'serviço de análise de vídeo',
  'camera-worker': 'serviço de processamento de câmeras',
});

function alertaInfraAmigavel(codigo, mensagem) {
  const detalhe = String(mensagem ?? '').replace(/^Infra:\s*/i, '');
  const partes = detalhe.split(':').map((parte) => parte.trim());
  const tipo = partes[0] || codigo.replace(/^infra_/, '');

  if (tipo === 'container') {
    const nome = partes[1] || 'desconhecido';
    const rotulo = ROTULOS_SERVICO[nome] || `serviço ${nome.replace(/[-_]+/g, ' ')}`;
    return {
      key: `infra_container:${nome}`,
      level: 'critical',
      message: `O ${rotulo} da instalação não está funcionando.`,
    };
  }
  if (tipo === 'api') return { key: 'infra_api', level: 'critical', message: 'O serviço principal da instalação não está respondendo.' };
  if (tipo === 'web') return { key: 'infra_web', level: 'critical', message: 'A página do sistema na instalação não está respondendo.' };
  if (tipo === 'build-agent') return { key: 'infra_build_agent', level: 'warning', message: 'O serviço de geração do aplicativo não está respondendo.' };
  if (tipo === 'live') return { key: `infra_live:${partes[1] || 'video'}`, level: 'critical', message: 'O serviço de vídeo ao vivo não está respondendo corretamente.' };
  if (tipo === 'backup') return { key: 'infra_backup', level: 'warning', message: 'A instalação está sem um backup recente há mais de 36 horas.' };
  if (tipo === 'security') return { key: 'infra_security_log', level: 'critical', message: 'O sistema encontrou uma possível informação sigilosa nos registros. A equipe técnica deve verificar.' };
  if (tipo === 'site-cameras') return { key: 'infra_camera_network', level: 'critical', message: 'A rede das câmeras não está respondendo a partir do servidor da instalação.' };

  return {
    key: codigo || 'infra_unknown',
    level: 'warning',
    message: 'A instalação detectou um problema interno que precisa de verificação técnica.',
  };
}

/**
 * Converte o contrato técnico do heartbeat em texto para o operador.
 *
 * A Central pode receber heartbeat de versões antigas durante meses. Fazer a
 * tradução aqui mantém Telegram, e-mail, histórico e tela compreensíveis sem
 * exigir que todas as instalações sejam atualizadas ao mesmo tempo.
 */
function normalizarAlertaOperacional(entrada) {
  const alerta = entrada && typeof entrada === 'object' ? entrada : {};
  const code = String(alerta.code || 'generic').trim().toLowerCase().slice(0, 100);
  const original = String(alerta.message || '').trim().slice(0, 500);
  const informado = String(alerta.key || '').trim().toLowerCase().slice(0, 160);
  let level = alerta.level === 'critical' ? 'critical' : 'warning';
  let key = informado || code;
  let message = original || 'A instalação informou um problema operacional.';
  const n = primeiroNumero(original);

  switch (code) {
    case 'disk_usage_high':
      key = informado || 'disk_usage';
      level = 'critical';
      message = `O disco do servidor está com ${n}% de uso. O espaço para novas gravações está crítico.`;
      break;
    case 'disk_usage_attention':
      key = informado || 'disk_usage';
      message = `O disco do servidor está com ${n}% de uso e precisa de atenção.`;
      break;
    case 'cameras_unavailable':
      message = `${quantidade(n, 'câmera')} ${n === 1 ? 'está' : 'estão'} sem comunicação ou com erro.`;
      break;
    case 'no_online_cameras':
      level = 'critical';
      message = 'Todas as câmeras da instalação estão sem comunicação.';
      break;
    case 'stream_high_cpu_risk':
      message = `${quantidade(n, 'câmera')} ${n === 1 ? 'está exigindo' : 'estão exigindo'} processamento elevado para exibir vídeo. As imagens podem apresentar lentidão.`;
      break;
    case 'live_failures_recent':
      message = `${n === 1 ? 'Foi detectada' : 'Foram detectadas'} ${quantidade(n, 'falha')} ao abrir imagens ao vivo nas últimas 24 horas.`;
      break;
    case 'recording_without_last_segment':
      message = 'O sistema não conseguiu identificar o horário da gravação mais recente.';
      break;
    case 'recording_disabled_all':
      message = 'Nenhuma câmera está configurada para gravar, embora a instalação exija gravação.';
      break;
    case 'recording_storage_capacity_insufficient':
      key = informado || 'recording_storage_capacity';
      level = 'critical';
      message = 'O armazenamento disponível não é suficiente para manter o período de gravações configurado.';
      break;
    case 'recording_storage_capacity_attention':
      key = informado || 'recording_storage_capacity';
      message = 'O armazenamento está próximo do limite necessário para manter o período de gravações configurado.';
      break;
    case 'cameras_stalled':
      message = `${quantidade(n, 'câmera')} ${n === 1 ? 'parou' : 'pararam'} de gerar novas gravações.`;
      break;
    case 'camera_recording_expected_inactive':
      message = `${quantidade(n, 'câmera')} ${n === 1 ? 'deveria estar gravando, mas não está' : 'deveriam estar gravando, mas não estão'}.`;
      break;
    case 'motion_detection_failsafe':
      message = `A detecção de movimento deixou de responder em ${quantidade(n, 'câmera')}. A gravação de segurança foi ativada automaticamente.`;
      break;
    case 'cloud_recordings_missing':
      level = 'critical';
      message = `${quantidade(n, 'gravação', 'gravações')} ${n === 1 ? 'que deveria estar armazenada na nuvem não foi encontrada' : 'que deveriam estar armazenadas na nuvem não foram encontradas'}.`;
      break;
    case 'cloud_upload_delayed':
      message = `${quantidade(n, 'gravação', 'gravações')} ${n === 1 ? 'aguarda' : 'aguardam'} envio para a nuvem há mais tempo que o esperado.`;
      break;
    case 'infra_watchdog_stale':
      message = 'O serviço que verifica a saúde da instalação não envia informações há mais de 15 minutos.';
      break;
    case 'installation_offline':
      key = informado || 'installation_connectivity';
      level = 'critical';
      message = original || 'A instalação parou de se comunicar com a Central. A equipe deve verificar a internet e o servidor local.';
      break;
    default:
      if (code.startsWith('infra_')) {
        // Um heartbeat novo já pode mandar a frase amigável junto de uma chave
        // estável. Heartbeats antigos mandavam `Infra:tipo:detalhe`; só esse
        // formato precisa ser traduzido novamente.
        if (!informado || /^Infra:\s*/i.test(original)) {
          const infra = alertaInfraAmigavel(code, original);
          key = informado || infra.key;
          level = infra.level;
          message = infra.message;
        }
      }
      break;
  }

  return { key, level, code, message };
}

/**
 * Monta a mensagem. Curta de propósito: chega no celular de alguém que talvez
 * esteja dormindo, e precisa responder "onde, o quê, quando" sem abrir nada.
 */
function montarMensagem({ instalacao, alertas, recuperado = false, teste = false }) {
  const nome = String(instalacao?.customerName || instalacao?.name || instalacao?.id || 'Instalação').replace(/[\r\n\x00-\x1f]/g,' ').slice(0,120);
  const normalizados = alertas.map(a => ({ ...normalizarAlertaOperacional(a), recoveryMessage: a.recoveryMessage }));
  const temCritico = normalizados.some((alerta) => alerta.level === 'critical');
  const titulo = teste ? `📩 Teste de avisos — ${nome}` : recuperado
    ? `✅ Problema resolvido — ${nome}`
    : temCritico
      ? `🚨 Problema crítico — ${nome}`
      : `⚠️ Atenção necessária — ${nome}`;
  const linhas = normalizados.slice(0, 8).map((a) => `• ${String(recuperado ? mensagemRecuperacao(a) : a.message).slice(0,320)}`);
  if (alertas.length > 8) linhas.push(`• …e mais ${alertas.length - 8}`);
  const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });

  return {
    assunto: titulo,
    texto: [titulo, '', ...linhas, '', `Em ${quando}`].join('\n'),
    html: [
      `<b>${escaparTelegram(titulo)}</b>`,
      '',
      ...linhas.map(escaparTelegram),
      '',
      `<i>Em ${escaparTelegram(quando)}</i>`,
    ].join('\n'),
  };
}

function mensagemRecuperacao(alerta) {
  if (alerta.recoveryMessage) return alerta.recoveryMessage;
  if (alerta.code === 'installation_offline') return 'O servidor voltou a se comunicar com a Central.';
  if (alerta.code.startsWith('disk_usage')) return 'O uso do armazenamento voltou a um nível seguro.';
  if (['cameras_unavailable','no_online_cameras','camera_offline'].includes(alerta.code)) return 'A comunicação com as câmeras foi restabelecida.';
  if (alerta.code.startsWith('recording') || alerta.code === 'cameras_stalled') return 'O aviso sobre gravações foi encerrado após a atualização das informações do sistema.';
  return 'O sistema deixou de informar o problema anterior.';
}

/** Dispara nos canais LIGADOS. Um canal quebrado não impede o outro. */
async function despacharAlerta(config, mensagem) {
  const c = normalizarAlertas(config);
  const resultados = [];
  if (c.telegramEnabled) {
    const r = await enviarTelegram(c, mensagem.html);
    resultados.push({ canal: 'telegram', ...r });
  }
  if (c.emailEnabled) {
    const r = await enviarEmail(c.emails, mensagem.assunto, mensagem.texto);
    resultados.push({ canal: 'email', ...r });
  }
  return resultados;
}

module.exports = {
  CONFIG_PADRAO,
  LIMITE_EMAILS,
  normalizarAlertas,
  alertasPublicos,
  mesclarAlertas,
  montarMensagem,
  despacharAlerta,
  enviarTelegram,
  enviarEmail,
  smtpConfigurado,
  cifrar,
  decifrar,
  emailPlausivel,
  normalizarAlertaOperacional,
};
