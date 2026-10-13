'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startCentral } = require('./helpers/central-server');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function ui(answer, response = { ok: true }) {
  const button = { disabled: false }, calls = [], notices = [], views = [];
  const state = { selectedId: 'old-client' };
  const context = { state, window: { prompt: () => answer }, document: { getElementById: () => button },
    localStorage: { removeItem: key => calls.push(['clear', key]) },
    selectedItem: () => state.selectedId ? { id: state.selectedId } : null,
    centralUrl: value => value, showToast: value => notices.push(value),
    setView: value => views.push(value), load: async () => calls.push(['load']),
    fetch: async (url, options) => { calls.push(['fetch', url, options]); if (response instanceof Error) throw response; return response; } };
  vm.createContext(context);
  const start = html.indexOf('      let removingInstallation = false;');
  const end = html.indexOf('      async function deletePendingInstallation(', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(html.slice(start, end), context);
  return { ...context, button, calls, notices, views };
}
test('exclusion is visible above the tabs and targets the current selection', () => {
  assert.ok(html.indexOf('id="delete-installation-top"') < html.indexOf('id="detalhe-abas"'));
  assert.equal(html.match(/id="delete-installation-top"/g).length, 1);
  assert.match(html, /const item = selectedItem\(\);\s+if \(item\) void removeInstallation\(item.id\)/);
  assert.doesNotMatch(html, /state\.selected = null/);
});
test('cancel and incorrect confirmation do not send a deletion', async () => {
  for (const answer of [null, '', 'other-client']) {
    const page = ui(answer); await page.removeInstallation('old-client');
    assert.equal(page.calls.length, 0); assert.equal(page.state.selectedId, 'old-client');
  }
});
test('confirmed removal clears selection and returns to the list', async () => {
  const page = ui(' old-client '); await page.removeInstallation('old-client');
  const call = page.calls.find(x => x[0] === 'fetch');
  assert.equal(call[1], '/api/admin/installations/old-client?confirmar=old-client');
  assert.equal(call[2].method, 'DELETE'); assert.equal(call[2].credentials, 'include');
  assert.equal(page.state.selectedId, ''); assert.deepEqual(page.views, ['operacao']);
  assert.ok(page.calls.some(x => x[0] === 'load'));
});
test('server and network errors keep the selected installation and allow retry', async () => {
  for (const response of [{ ok: false, json: async () => ({ message: 'Falha de teste' }) }, new Error('network')]) {
    const page = ui('old-client', response); await page.removeInstallation('old-client');
    assert.equal(page.state.selectedId, 'old-client'); assert.equal(page.views.length, 0);
    assert.equal(page.button.disabled, false); assert.equal(page.notices.length, 1);
  }
});
test('real HTTP deletion is authenticated, confirmed, isolated, audited and rejects the old agent', async () => {
  const central = await startCentral();
  const request = (url, method = 'GET', body, headers = central.adminHeaders()) => fetch(central.base + url,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const first = await (await request('/api/admin/provision', 'POST', { customerName: 'Former customer', installationId: 'delete-fixture', serverAddress: 'https://delete.example' })).json();
    await request('/api/admin/provision', 'POST', { customerName: 'Other customer', installationId: 'keep-fixture', serverAddress: 'https://keep.example' });
    const agentHeaders = { 'content-type': 'application/json', 'x-drac-installation-id': 'delete-fixture', 'x-drac-license-key': first.licenseKey };
    assert.equal((await request('/api/agent/heartbeat', 'POST', {}, agentHeaders)).status, 200);
    const target = '/api/admin/installations/delete-fixture';
    assert.equal((await request(target + '?confirmar=delete-fixture', 'DELETE', undefined, {})).status, 401);
    assert.equal((await request(target, 'DELETE')).status, 428);
    assert.equal((await request(target + '?confirmar=keep-fixture', 'DELETE')).status, 428);
    assert.equal((await request(target + '?confirmar=delete-fixture', 'DELETE')).status, 200);
    assert.equal((await request(target)).status, 404);
    assert.equal((await request('/api/admin/installations/keep-fixture')).status, 200);
    assert.equal((await request('/api/agent/heartbeat', 'POST', {}, agentHeaders)).ok, false);
    const list = await (await request('/api/admin/installations')).json();
    assert.equal(list.items.some(item => item.id === 'delete-fixture'), false);
    const audit = await (await request('/api/admin/audit')).json();
    assert.ok(audit.items.some(item => item.type === 'installation.removed' && item.installationId === 'delete-fixture'));
  } finally { await central.stop(); }
});
