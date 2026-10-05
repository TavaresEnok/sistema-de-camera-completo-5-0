'use strict';

// ── VERSÃO APROVADA DA FROTA ────────────────────────────────────────────────
//
// O problema que isto resolve: até 10/08/2026 a versão que uma instalação nova
// recebia era a variável de ambiente `DRAC_CENTRAL_INSTALLER_COMMIT`, cozida no
// container da Central. Consequências:
//
//   · atualizar a frota exigia editar .env e RECRIAR o container (não basta
//     reiniciar — o env é cozido), ou seja, linha de comando;
//   · nada ligava essa versão a ter sido TESTADA. Era uma afirmação;
//   · nenhuma instalação sabia que estava atrasada, e a Central não sabia
//     dizer quem estava em quê.
//
// Aqui a versão aprovada vira DADO, com evidência de teste obrigatória, e desce
// para as instalações pelo canal que já existe (a resposta do heartbeat) — sem
// abrir porta na instalação nem inverter o sentido da conexão, o que
// funcionaria mal atrás de NAT, que é a maioria delas.
//
// O FLUXO, e por que a matriz existe:
//   1. constrói-se e testa-se na MATRIZ (a instalação principal);
//   2. o gate de instalação limpa roda naquele commit;
//   3. só então ele é PROMOVIDO aqui;
//   4. as demais instalações veem que estão atrás e podem ser atualizadas.
//
// Promover sem evidência de gate é recusado. Foi exatamente a ausência disso
// que fez a primeira instalação de cliente virar uma sequência de consertos.

const COMMIT_RE = /^[0-9a-f]{40}$/;
const {bundleMetadata}=require('./runtime-artifacts');

/** Commit em forma canônica (minúsculo, 40 hex) ou null se não for um. */
function normalizarCommit(valor) {
  const texto = String(valor ?? '').trim().toLowerCase();
  return COMMIT_RE.test(texto) ? texto : null;
}

/**
 * A evidência de que o commit foi testado.
 *
 * `instalacaoLimpa` é o gate da máquina virgem; `verificadaNaMatriz` é a
 * bateria rodada contra a instalação principal. Exigimos as DUAS: a primeira
 * prova que instala do zero, a segunda prova que roda de verdade com dados
 * reais. Uma não substitui a outra.
 */
function validarEvidencia(gate) {
  if (!gate || typeof gate !== 'object') {
    return { ok: false, erro: 'gate_ausente' };
  }
  if (gate.instalacaoLimpa !== true) return { ok: false, erro: 'gate_instalacao_limpa_ausente' };
  if (gate.verificadaNaMatriz !== true) return { ok: false, erro: 'gate_matriz_ausente' };
  const em = String(gate.em ?? '').trim();
  if (!em || Number.isNaN(Date.parse(em))) return { ok: false, erro: 'gate_sem_data_valida' };
  return { ok: true };
}

/**
 * Valida um pedido de promoção. Devolve `{ ok, erro, release }`.
 *
 * `permitirSemGate` existe para uma única situação legítima: um ROLLBACK de
 * emergência para um commit que já esteve aprovado antes (portanto já passou
 * pelo gate um dia). Nunca para promover novidade.
 */
function validarPromocao(pedido, { historico = [], agora = new Date(), permitirSemGate = false } = {}) {
  const commit = normalizarCommit(pedido?.commit);
  if (!commit) return { ok: false, erro: 'commit_invalido' };

  const jaFoiAprovado = historico.some((r) => r?.commit === commit);
  if (!permitirSemGate || !jaFoiAprovado) {
    const evidencia = validarEvidencia(pedido?.gate);
    if (!evidencia.ok) return { ok: false, erro: evidencia.erro };
  }

  const repositoryUrl = String(pedido?.repositoryUrl ?? '').trim();
  let runtimeBundle;
  if (pedido?.runtimeBundle != null) {
    try { runtimeBundle = bundleMetadata(pedido.runtimeBundle); }
    catch { return {ok:false,erro:'runtime_bundle_invalid'}; }
  }
  if (repositoryUrl && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~/-]+$/.test(repositoryUrl)) {
    return { ok: false, erro: 'repositorio_invalido' };
  }

  return {
    ok: true,
    release: {
      commit,
      repositoryUrl: repositoryUrl || null,
      // SHA-256 do instalador daquele commit. Sem ele a release sabe QUAL
      // versão foi aprovada e não sabe PROVAR o script que a instala — e o
      // artefato teria de voltar a confiar no ambiente, que é o que separava
      // "promover" de "instalar" (19/08/2026).
      installerSha256: String(pedido?.installerSha256 ?? '').trim().toLowerCase() || null,
      ...(runtimeBundle ? {runtimeBundle} : {}),
      notas: String(pedido?.notas ?? '').trim().slice(0, 2000) || null,
      gate: pedido?.gate ?? null,
      rollback: Boolean(permitirSemGate && jaFoiAprovado),
      promovidoEm: agora.toISOString(),
      promovidoPor: String(pedido?.promovidoPor ?? '').trim() || null,
    },
  };
}

/**
 * Onde uma instalação está em relação à versão aprovada.
 *
 * `desconhecida` é diferente de `atrasada` de propósito: instalação que nunca
 * mandou versão (ou está fora do ar) não pode ser contada como atualizada nem
 * empurrada às cegas — o operador precisa ver que não se sabe.
 */
function situacaoDaInstalacao(instalacao, release) {
  release = approvedForInstallation(release, instalacao);
  const atual = normalizarCommit(instalacao?.version);
  const aprovado = release ? normalizarCommit(release.commit) : null;
  if (!aprovado) return 'sem-release';
  if (!atual) return 'desconhecida';
  if (atual === aprovado) return 'atualizada';
  return 'atrasada';
}

/** Contagem por situação, para o painel dizer o estado da frota numa linha. */
function resumoDaFrota(instalacoes, release) {
  const resumo = { total: 0, atualizada: 0, atrasada: 0, desconhecida: 0, 'sem-release': 0 };
  for (const inst of Object.values(instalacoes || {})) {
    resumo.total += 1;
    resumo[situacaoDaInstalacao(inst, release)] += 1;
  }
  return resumo;
}

/**
 * O que desce para a instalação no heartbeat.
 *
 * Só o necessário para ela saber se está atrasada e de onde buscar. Nada de
 * histórico ou notas: é canal de máquina, não de leitura humana.
 */
function releaseParaInstalacao(release, instalacao) {
  release = approvedForInstallation(release, instalacao);
  if (!release?.commit) return null;
  return {
    commit: release.commit,
    repositoryUrl: release.repositoryUrl || null,
    promovidoEm: release.promovidoEm || null,
    situacao: situacaoDaInstalacao(instalacao, release),
    ...(release.runtimeBundle ? {runtimeBundle:release.runtimeBundle} : {}),
  };
}

// An explicitly approved pilot is pinned to one installation. It must never
// cause unrelated tenants to download/update to that candidate release.
function approvedForInstallation(release, installation) {
  return installation?.runtimeRelease || release;
}

function validarRuntimePilot(pedido, agora = new Date()) {
  const commit = normalizarCommit(pedido?.commit);
  if (!commit) return {ok:false,erro:'commit_invalido'};
  let runtimeBundle;
  try { runtimeBundle = bundleMetadata(pedido.runtimeBundle); }
  catch { return {ok:false,erro:'runtime_bundle_invalid'}; }
  const gate=pedido?.gate;
  if (!gate || gate.runtimeFresh!==true || gate.signatureVerified!==true || gate.dataPreservationReviewed!==true
      || !/^[a-f0-9]{64}$/.test(String(gate.reportSha256||'')) || !gate.em || Number.isNaN(Date.parse(gate.em))) {
    return {ok:false,erro:'runtime_pilot_evidence_required'};
  }
  if (!/^[a-f0-9]{64}$/.test(String(pedido.installerSha256||''))) return {ok:false,erro:'installer_hash_required'};
  return {ok:true,release:{commit,runtimeBundle,installerSha256:pedido.installerSha256,gate,
    scope:'installation-only',notas:String(pedido.notas||'').slice(0,2000),promovidoEm:agora.toISOString(),promovidoPor:pedido.promovidoPor||null}};
}

/** Guarda a promoção no histórico, mais nova primeiro, sem duplicar seguidas. */
function registrarNoHistorico(historico, release, { maximo = 50 } = {}) {
  const anterior = Array.isArray(historico) ? historico : [];
  if (anterior[0]?.commit === release.commit) {
    return [{ ...anterior[0], ...release }, ...anterior.slice(1)].slice(0, maximo);
  }
  return [release, ...anterior].slice(0, maximo);
}

module.exports = {
  normalizarCommit,
  validarEvidencia,
  validarPromocao,
  situacaoDaInstalacao,
  resumoDaFrota,
  releaseParaInstalacao,
  approvedForInstallation,
  validarRuntimePilot,
  registrarNoHistorico,
};
