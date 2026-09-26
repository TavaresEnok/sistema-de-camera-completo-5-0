'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startCentral } = require('./helpers/central-server');

test('corpo lento não ocupa a fila de mutações e readiness continua real', async (t) => {
  const central = await startCentral({ DRAC_CENTRAL_BODY_TIMEOUT_MS: '1000' });
  t.after(() => central.stop());
  let slow;
  const pending = new Promise((resolve, reject) => {
    slow = http.request(`${central.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '100' },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    slow.on('error', reject);
    slow.write('{');
  });
  t.after(() => slow.destroy());
  await new Promise(resolve => setTimeout(resolve, 100));
  const [ready, installations] = await Promise.all([
    fetch(`${central.base}/api/ready`),
    fetch(`${central.base}/api/admin/installations`, { headers: central.adminHeaders() }),
  ]);
  assert.equal(ready.status, 200);
  assert.equal(installations.status, 200);
  assert.equal(await pending, 408);
});
