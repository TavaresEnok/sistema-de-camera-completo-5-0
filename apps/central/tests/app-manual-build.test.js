'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { startCentral } = require('./helpers/central-server');
test('saving every app field never starts a build; explicit generation still works', async () => {
  const calls = [];
  const agent = http.createServer((req, res) => { calls.push({ method: req.method, path: req.url }); req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/builds' ? { jobId: 'synthetic-job', status: 'queued' } : { ok: true })); });
  await new Promise(resolve => agent.listen(0, '127.0.0.1', resolve));
  const central = await startCentral({ APP_BUILDER_AGENT_URL: `http://127.0.0.1:${agent.address().port}`, APP_BUILDER_AGENT_TOKEN: 'synthetic-only' });
  try {
    const request = (url, method = 'GET', body) => fetch(central.base + url, { method, headers: central.adminHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await request('/api/admin/provision', 'POST', { customerName: 'Fixture', installationId: 'manual-build', serverAddress: 'https://fixture.example.invalid' })).status, 201);
    const file = path.join(central.dir, 'installations.json');
    const db = JSON.parse(await fs.readFile(file, 'utf8'));
    db.release = { commit: 'a'.repeat(40) };
    db.installations['manual-build'].app = { slug: 'manual-build', lastBuildAt: '2026-01-01T00:00:00Z', lastBuildJobId: 'old-job' };
    await fs.writeFile(file, JSON.stringify(db));
    const prefix = '/api/admin/installations/manual-build';
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    for (const body of [{ appName: 'Changed name' }, { packageId: 'com.fixture.changed' }, { apiUrl: 'https://changed.example.invalid/api' }, { pushEnabled: true }, { appIconDataUrl: icon }, { branding: { facilityName: 'Changed name', brandLogoDataUrl: icon, brandUseDefaultColors: true } }]) {
      const response = await request(prefix + '/app', 'PATCH', body);
      assert.equal(response.status, 200, await response.clone().text());
      const data = await response.json(); assert.equal(data.rebuildTriggered, false); assert.equal(data.rebuild, null);
    }
    assert.equal(calls.length, 0);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.installations['manual-build'].app.lastBuildAt, '2026-01-01T00:00:00Z');
    assert.equal(saved.installations['manual-build'].app.lastBuildJobId, 'old-job');
    await request(prefix + '/app', 'PATCH', { pushEnabled: false });
    const generated = await request(prefix + '/generate-app', 'POST', {});
    assert.ok(generated.ok, await generated.text());
    assert.equal(calls.filter(x => x.method === 'POST' && x.path === '/builds').length, 1);
  } finally { await central.stop(); await new Promise(resolve => agent.close(resolve)); }
});
