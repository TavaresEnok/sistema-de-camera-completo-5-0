const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('/tools/node_modules/playwright-core');
const root = '/app/apps/web/dist';
const recorder = { id: 'test-recorder', name: 'Gravador de teste', ip: '192.168.1.20', username: 'operator', manufacturer: 'intelbras', rtspPort: 554, httpPort: 80, groupId: 'group', group: { name: 'Grupo de teste' } };
const user = { id: 'test-admin', name: 'Teste', username: 'test', email: 'test@example.invalid', role: 'ADMIN' };
let debugPage;
async function scenario(browser, flag, viewport) {
  const context = await browser.newContext({ viewport }); const page = await context.newPage();
  debugPage = page; page.setDefaultTimeout(12000);
  let saved = false, channels = [], imports = 0, writes = 0;
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (p.startsWith('/api/')) {
      console.log('fixture', request.method(), p);
      if (p.endsWith('/auth/refresh')) return json({ accessToken: 'fixture-token', user });
      if (p.endsWith('/auth/me')) return json(user);
      if (p.endsWith('/settings/branding')) return json({ facilityName: 'S2Cam', recordersEnabled: flag, aiFeatureEnabled: false });
      if (p.endsWith('/role-permissions/me')) return json({ role: 'ADMIN', permissions: { cameraConfig: true, serverConfig: true, liveView: true, playback: true, userManage: true } });
      if (p.endsWith('/commercial-policy')) return json({ licenseStatus: 'ACTIVE', restrictions: {} });
      if (p.endsWith('/license/status')) return json({ status: 'ACTIVE', licenseStatus: 'ACTIVE', restrictions: {} });
      if (p.endsWith('/health/system')) return json({ status: 'ok', disk: { usagePercent: 20 }, memory: {}, cpu: {}, services: [] });
      if (p.endsWith('/camera-groups')) return json([{ id: 'group', name: 'Grupo de teste' }]);
      if (p === '/api/recorders') {
        if (request.method() === 'POST') { assert.equal(flag, true); assert.equal(request.postDataJSON().password, 'fake-test-password'); writes++; saved = true; return json({ ...recorder, channels }); }
        return json(saved ? [{ ...recorder, _count: { channels: channels.length } }] : []);
      }
      if (p === '/api/recorders/test-recorder') return json({ ...recorder, channels });
      if (p.endsWith('/recorders/test-recorder/check')) return json({ ok: true, frame: { ok: true, imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZcAAAAASUVORK5CYII=' } });
      if (p.endsWith('/recorders/test-recorder/import')) { imports++; assert.equal(request.postDataJSON().channels[0].channel, 1); channels = [{ id: 'cam-1', channel: 1, name: 'Canal 1', enabled: true, status: 'ONLINE', recordingMode: 'manual' }]; return json({ results: [{ channel: 1, name: 'Canal 1', status: 'created', cameraId: 'cam-1' }] }); }
      if (p.endsWith('/settings')) return json({});
      if (p.endsWith('/health/ready')) return json({ ready: true });
      return json([]);
    }
    if (url.hostname !== 's2cam.example.test') return route.abort();
    const file = path.join(root, p.startsWith('/assets/') ? p : 'index.html');
    const mime = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: mime, body: fs.readFileSync(file) });
  });
  await page.goto('http://s2cam.example.test/recorders');
  await page.waitForTimeout(1500);
  console.log('body', (await page.locator('body').innerText()).slice(0, 1200));
  if (!flag) {
    await page.getByText('DVR/NVR não está disponível para este acesso.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Adicionar gravador' }).count(), 0);
    assert.equal(writes, 0);
  } else {
    await page.getByRole('button', { name: 'Adicionar gravador' }).click();
    await page.getByLabel('Nome', { exact: true }).fill('Gravador de teste');
    await page.getByLabel('IP do gravador').fill('192.168.1.20');
    await page.getByLabel('Usuário', { exact: true }).fill('operator');
    await page.getByLabel('Senha', { exact: true }).fill('fake-test-password');
    assert.equal(await page.getByLabel('Senha', { exact: true }).getAttribute('type'), 'password');
    await page.getByRole('combobox', { name: 'Cliente / grupo' }).click();
    await page.getByRole('option', { name: 'Grupo de teste' }).click();
    await page.getByRole('button', { name: 'Salvar e escolher canais' }).click();
    await page.getByRole('heading', { name: 'Gravador de teste' }).waitFor();
    await page.getByRole('button', { name: 'Manual', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Importar 1 canal', exact: true }).isEnabled(), false);
    await page.getByRole('button', { name: 'Verificar vídeo' }).click();
    await page.getByRole('button', { name: 'Vídeo confirmado' }).waitFor();
    await page.getByRole('button', { name: 'Importar 1 canal', exact: true }).click();
    await page.getByText('Canal 1: importado', { exact: true }).waitFor();
    assert.equal(imports, 1); assert.equal(writes, 1);
    await page.screenshot({ path: `/out/recorders-${viewport.width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  await context.close();
}
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try { await scenario(browser, true, { width: 1440, height: 1000 }); await scenario(browser, true, { width: 390, height: 844 }); await scenario(browser, false, { width: 1440, height: 1000 }); console.log('OK: desktop, mobile, manual channel verification/import, password masking, feature disabled, no real API access.'); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
