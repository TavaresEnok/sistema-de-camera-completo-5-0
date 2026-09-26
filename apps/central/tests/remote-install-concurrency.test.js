'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startCentral } = require('./helpers/central-server');

test('remote-install preserva provisionamento concorrente durante leitura do corpo', async (t) => {
  const central = await startCentral();
  t.after(() => central.stop());
  async function provision(id) {
    const response = await fetch(`${central.base}/api/admin/provision`, {
      method: 'POST', headers: central.adminHeaders(),
      body: JSON.stringify({ installationId: id, customerName: id, serverAddress: '192.0.2.10' }),
    });
    assert.equal(response.status, 201);
  }
  await provision('audit-a');
  const body = JSON.stringify({ host: '127.0.0.1', port: 1, username: 'fixture', password: 'synthetic' });
  let request;
  const completed = new Promise((resolve, reject) => {
    request = http.request(`${central.base}/api/admin/installations/audit-a/remote-install`, {
      method: 'POST', headers: central.adminHeaders({ 'content-length': Buffer.byteLength(body) }),
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.write(body.slice(0, 1));
  });
  t.after(() => request.destroy());
  // Deixa a rota antiga carregar seu snapshot antes de bloquear em readBody.
  await new Promise(resolve => setTimeout(resolve, 250));
  await provision('audit-b');
  request.end(body.slice(1));
  assert.equal(await completed, 202);
  const response = await fetch(`${central.base}/api/admin/installations`, { headers: central.adminHeaders() });
  const { items } = await response.json();
  assert.deepEqual(items.map(item => item.installationId || item.id).sort(), ['audit-a', 'audit-b']);
});
