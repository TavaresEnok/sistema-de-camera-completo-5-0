// Production smoke check: Vibe only, no recorder/camera/configuration writes.
// Read { username, password } from stdin; never print credentials or tokens.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('/tools/node_modules/playwright-core');
const origin = 'https://vibe.s2cam.com.br';

(async () => {
  const credentials = JSON.parse(fs.readFileSync(0, 'utf8'));
  assert.ok(credentials.username && credentials.password, 'Missing smoke-check credentials');
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const login = await context.request.post(origin + '/api/auth/login', {
      headers: { 'x-drac-auth-mode': 'cookie' }, data: credentials,
    });
    credentials.password = '';
    assert.equal(login.status(), 201, 'Admin login failed');
    const page = await context.newPage();
    const errors = [], blockedWrites = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      const read = ['GET', 'HEAD', 'OPTIONS'].includes(request.method());
      const session = request.method() === 'POST' && url.pathname === '/api/auth/refresh';
      if (!read && !session) { blockedWrites.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    const listResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/recorders');
    await page.goto(origin + '/recorders');
    const list = await listResponse;
    assert.equal(list.status(), 200, 'Recorder API failed');
    const rows = await list.json();
    assert.ok(Array.isArray(rows), 'Unexpected recorder response');
    await page.getByRole('main').getByRole('heading', { name: 'DVR/NVR', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Adicionar gravador', exact: true }).click();
    await page.getByLabel('IP do gravador').waitFor();
    assert.equal(await page.getByLabel('Senha', { exact: true }).getAttribute('type'), 'password');
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Adicionar gravador', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('main').getByRole('heading', { name: 'DVR/NVR', exact: true }).waitFor();
    assert.deepEqual(errors, [], 'Browser JavaScript error');
    assert.deepEqual(blockedWrites, [], 'Page attempted an unexpected write');
    console.log(JSON.stringify({ target: origin, authenticatedPage: true, apiStatus: list.status(),
      recorderCount: rows.length, desktop: true, mobile: true, reloadPreservesLogin: true,
      passwordMasked: true, applicationWrites: 0, javascriptErrors: 0 }));
  } finally {
    // Do not call the global logout endpoint: it would revoke the operator's other sessions.
    await context.close(); await browser.close();
  }
})().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
