'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const sgp = require('../src/sgp-integration');
const { startCentral } = require('./helpers/central-server');

test('only verifier hashes are persisted; each installation has its own key', () => {
  const a = {}, b = {};
  const one = sgp.changeToken(a, { expectedRevision: 0, requestId: randomUUID() }, 'admin');
  const two = sgp.changeToken(b, { expectedRevision: 0, requestId: randomUUID() }, 'admin');
  assert.match(one, /^s2sgp_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.sgpIntegration.integrationId, b.sgpIntegration.integrationId);
  assert.notEqual(one, two);
  assert.equal(JSON.stringify(a).includes(one), false);
  assert.equal(JSON.stringify(sgp.publicState(a, 'https://vibe.example/api')).includes('keyHash'), false);
  assert.equal(JSON.stringify(sgp.delivery(a)).includes(one), false);
});
test('generation, stale edits, acknowledgement and revocation do not falsely confirm application', () => {
  const item = { supportedConfigKeys: ['sgpIntegration'] };
  sgp.changeToken(item, { expectedRevision: 0, requestId: randomUUID() }, 'admin');
  const id = item.sgpIntegration.integrationId;
  assert.equal(sgp.publicState(item).status, 'PENDING');
  sgp.acknowledge(item, { integrationId: id, revision: 0, status: 'APPLIED' }, new Date().toISOString());
  assert.equal(sgp.publicState(item).status, 'PENDING');
  sgp.acknowledge(item, { integrationId: id, revision: 1, status: 'APPLIED', enabled: true }, new Date().toISOString());
  assert.equal(sgp.publicState(item).status, 'APPLIED');
  assert.throws(() => sgp.changeToken(item, { expectedRevision: 0, requestId: randomUUID() }, 'admin'), /outra tela/);
  sgp.changeToken(item, { expectedRevision: 1, requestId: randomUUID() }, 'admin', true);
  assert.equal(sgp.publicState(item).status, 'PENDING');
  sgp.acknowledge(item, { integrationId: id, revision: 2, status: 'APPLIED', enabled: false }, new Date().toISOString());
  assert.equal(sgp.publicState(item).status, 'REVOKED');
  assert.equal(item.sgpIntegration.keyHash, null);
});
test('connections use the installation HTTPS URL and reject embedded credentials', () => {
  assert.equal(sgp.connection('https://vibe.example/api').installationUrl, 'https://vibe.example');
  assert.equal(sgp.connection('https://ib.example').webhookUrl, 'https://ib.example/api/integrations/v1/sgp/webhook');
  for (const url of ['http://example.com', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/?key=secret']) assert.equal(sgp.connection(url), null);
});
test('Central HTTP routes require authentication, scope delivery and never list full tokens', async () => {
  const central = await startCentral();
  try {
    async function request(pathname, method = 'GET', body, headers = central.adminHeaders(), expected = 200) {
      const response = await fetch(central.base + pathname, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
      assert.equal(response.status, expected);
      return response.json();
    }
    const first = await request('/api/admin/provision', 'POST', { customerName: 'Vibe fixture', installationId: 'sgp-vibe', serverAddress: 'https://vibe.example' }, undefined, 201);
    const second = await request('/api/admin/provision', 'POST', { customerName: 'IB fixture', installationId: 'sgp-ib', serverAddress: 'https://ib.example' }, undefined, 201);
    const base = '/api/admin/installations/sgp-vibe/sgp/token';
    await request(base, 'POST', {}, { 'content-type': 'application/json' }, 401);
    await request(base, 'POST', { confirmInstallationId: 'sgp-ib' }, undefined, 400);
    const issued = await request(base, 'POST', { confirmInstallationId: 'sgp-vibe', expectedRevision: 0, requestId: randomUUID() });
    assert.match(issued.token, /^s2sgp_/);
    assert.equal(issued.sgpIntegration.status, 'PENDING');
    assert.equal(JSON.stringify(await request('/api/admin/installations')).includes(issued.token), false);
    const stored = await readFile(path.join(central.dir, 'installations.json'), 'utf8');
    assert.equal(stored.includes(issued.token), false);
    assert.equal(stored.includes('sgp_token_generated'), true);
    const heartHeaders = key => ({ 'content-type': 'application/json', 'x-drac-installation-id': 'sgp-vibe', 'x-drac-license-key': key });
    await request('/api/agent/heartbeat', 'POST', {}, heartHeaders(second.licenseKey), 403);
    const delivered = await request('/api/agent/heartbeat', 'POST', { configState: { supports: ['sgpIntegration'] } }, heartHeaders(first.licenseKey));
    assert.equal(delivered.sgpCredential.integrationId, issued.sgpIntegration.integrationId);
    assert.equal(JSON.stringify(delivered).includes(issued.token), false);
    const otherHeartbeat = await request('/api/agent/heartbeat', 'POST', {}, { 'content-type': 'application/json', 'x-drac-installation-id': 'sgp-ib', 'x-drac-license-key': second.licenseKey });
    assert.equal(otherHeartbeat.sgpCredential, null);
    await request('/api/agent/heartbeat', 'POST', { configState: { supports: ['sgpIntegration'] }, sgpState: { integrationId: delivered.sgpCredential.integrationId, revision: 1, status: 'APPLIED', enabled: true } }, heartHeaders(first.licenseKey));
    const confirmed = (await request('/api/admin/installations')).items.find(item => item.id === 'sgp-vibe');
    assert.equal(confirmed.sgpIntegration.status, 'APPLIED');
    assert.equal(central.logs.join('').includes(issued.token), false);
  } finally { await central.stop(); }
});
