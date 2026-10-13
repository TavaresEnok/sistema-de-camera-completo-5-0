'use strict';
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

function connection(apiUrl) {
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    const api = url.href.replace(/\/+$/, '');
    const base = api.endsWith('/api') ? api : api + '/api';
    return { installationUrl: base.slice(0, -4), baseUrl: base + '/integrations/v1/sgp', webhookUrl: base + '/integrations/v1/sgp/webhook' };
  } catch { return null; }
}
function publicState(item, apiUrl) {
  const desired = item.sgpIntegration;
  const ack = item.sgpIntegrationAck;
  let status = 'NONE';
  if (!desired && Array.isArray(item.supportedConfigKeys) && !item.supportedConfigKeys.includes('sgpIntegration')) status = 'UNSUPPORTED';
  if (desired) {
    status = 'PENDING';
    if (Array.isArray(item.supportedConfigKeys) && !item.supportedConfigKeys.includes('sgpIntegration')) status = 'UNSUPPORTED';
    else if (ack?.integrationId === desired.integrationId && ack.revision === desired.revision) {
      status = ack.status === 'APPLIED' ? desired.keyHash ? ack.enabled === false ? 'PAUSED' : 'APPLIED' : 'REVOKED' : 'FAILED';
    }
  }
  return { status, revision: desired?.revision || 0, integrationId: desired?.integrationId || null,
    hasToken: Boolean(desired?.keyHash), tokenSuffix: desired?.keyPrefix || null,
    changedAt: desired?.changedAt || null, confirmedAt: ack?.at || null,
    connection: connection(apiUrl), documentationUrl: 'https://s2cam.com.br/developers/sgp' };
}
function changeToken(item, { expectedRevision, requestId }, actor, revoke = false) {
  const previous = item.sgpIntegration;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (previous?.revision || 0)) throw fail(409, 'A integração foi alterada em outra tela. Atualize a página antes de continuar.');
  if (!/^[0-9a-f-]{36}$/i.test(requestId || '')) throw fail(400, 'Identificador da solicitação inválido.');
  if (previous?.lastRequestId === requestId && !revoke) throw fail(409, 'O token desta solicitação já foi gerado e não pode ser exibido novamente. Gere um novo token se não o guardou.');
  if (revoke && !previous?.keyHash) return null;
  const integrationId = previous?.integrationId || randomUUID();
  const token = revoke ? null : `s2sgp_${integrationId}.${randomBytes(32).toString('base64url')}`;
  item.sgpIntegration = { integrationId, revision: (previous?.revision || 0) + 1,
    keyHash: token ? sha(token) : null, keyPrefix: token ? token.slice(-6) : null,
    changedAt: new Date().toISOString(), changedBy: actor, lastRequestId: requestId };
  return token;
}
function delivery(item) {
  const value = item.sgpIntegration;
  return value ? { integrationId: value.integrationId, revision: value.revision, keyHash: value.keyHash, keyPrefix: value.keyPrefix } : null;
}
function acknowledge(item, value, at) {
  const desired = item.sgpIntegration;
  if (!desired || !value || value.integrationId !== desired.integrationId
    || !Number.isSafeInteger(value.revision) || value.revision !== desired.revision) return;
  item.sgpIntegrationAck = { integrationId: desired.integrationId, revision: value.revision,
    status: value.status === 'APPLIED' ? 'APPLIED' : 'FAILED', enabled: value.enabled === true, at };
}
module.exports = { connection, publicState, changeToken, delivery, acknowledge };
