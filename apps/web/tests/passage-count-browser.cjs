const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('/tools/node_modules/playwright-core');
const root = '/app/apps/web/dist';
const user = { id: 'admin', username: 'test', name: 'Teste', role: 'ADMIN' };

async function scenario(browser, width, lineFailure, role = 'ADMIN', playback = true) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', acceptDownloads: true });
  const page = await context.newPage();
  const errors = [], requests = [];
  let failLines = lineFailure;
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p.startsWith('/api/')) {
      if (p.endsWith('/auth/refresh')) return json({ accessToken: 'fixture-token', user: { ...user, role } });
      if (p.endsWith('/auth/me')) return json({ ...user, role });
      if (p.endsWith('/settings/branding')) return json({ facilityName: 'S2Cam', recordersEnabled: true });
      if (p.endsWith('/role-permissions/me')) return json({ role, permissions: { cameraConfig: role === 'ADMIN', liveView: true, playback } });
      if (p.endsWith('/health/system')) return json({ status: 'ok', disk: { usagePercent: 20 }, cpu: {}, memory: {}, services: [] });
      if (p.endsWith('/passage-counts/lines')) {
        if (failLines) return json({ message: 'fixture error' }, 500);
        return json([{ cameraId: 'c1', cameraName: 'Loja', lineId: 'door', lineName: 'Porta', classes: ['person'], active: true, enabled: true, lastPassageAt: '2026-11-16T13:00:00Z' },
          { cameraId: 'c2', cameraName: 'Loja 2', lineId: 'door', lineName: 'Porta', classes: ['person'], active: true, enabled: true, lastPassageAt: null },
          { cameraId: 'c1', cameraName: 'Loja', lineId: 'old', lineName: 'Porta antiga', classes: ['person'], active: false, enabled: false }]);
      }
      if (p.endsWith('/passage-counts')) {
        requests.push(url.searchParams);
        const days = Math.round((Date.parse(url.searchParams.get('to')) - Date.parse(url.searchParams.get('from'))) / 86400000);
        const count = url.searchParams.get('kind') === 'vehicle' ? 202 : days >= 29 ? 30 : days >= 6 ? 7 : 11;
        if (count === 7) await new Promise(r => setTimeout(r, 400));
        try { return await json({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), groupBy: url.searchParams.get('groupBy'), totals: { in: count, out: 3 },
          series: [{ bucket: '2026-11-16T10:00', cameraId: 'c1', lineId: 'door', lineName: 'Porta', in: count, out: 3 }] }); } catch { return; }
      }
      if (p.endsWith('/license/status') || p.endsWith('/commercial-policy')) return json({ status: 'ACTIVE', restrictions: {} });
      return json([]);
    }
    if (url.hostname !== 's2cam.example.test') return route.abort();
    const file = path.join(root, p.startsWith('/assets/') ? p : 'index.html');
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(file) });
  });
  await page.goto('http://s2cam.example.test/alarms?aba=contagem');
  await page.waitForURL('**/contagem');
  if (!playback) {
    await page.getByText('A contagem requer permissão de reprodução.').waitFor();
    assert.equal(requests.length, 0);
    assert.equal(await page.getByRole('link', { name: 'Contagem', exact: true }).count(), 0);
    await context.close();
    return;
  }
  const total = value => page.locator('[aria-live="polite"]').getByText(value, { exact: true });
  await total('11').waitFor();
  assert.equal(requests[0].get('kind'), 'person');
  const from = new Date(requests[0].get('from'));
  assert.equal(from.getUTCHours(), 3, 'Boundary must use Brazil even on a Tokyo workstation');
  if (lineFailure) {
    await page.getByRole('alert').getByText('Não foi possível carregar as linhas.').waitFor();
    assert.equal(await page.getByText('Nenhuma linha de contagem configurada.').count(), 0);
    failLines = false;
    await page.getByRole('button', { name: 'Tentar novamente' }).click();
  }
  await page.getByRole('option', { name: 'Loja · Porta', exact: true }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '7 dias', exact: true }).click();
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: '30 dias', exact: true }).click();
  await total('30').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.getByText('7', { exact: true }).count(), 0, 'Stale response replaced the selected report');
  await page.getByLabel('Mostrar saídas').check();
  await page.getByText('Saídas', { exact: true }).first().waitFor();
  await page.getByLabel('O que contar').selectOption('vehicle');
  await total('202').waitFor();
  const emptyLine = page.getByRole('listitem').filter({ hasText: 'Loja 2' });
  await emptyLine.getByText('Sem registro').waitFor();
  assert.equal(await emptyLine.getByText('0', { exact: true }).count(), 2);
  assert.equal(await page.getByRole('link', { name: 'Configurar linha', exact: true }).count(), role === 'ADMIN' ? 1 : 0);
  await page.getByLabel('Linha', { exact: true }).selectOption('c1|old');
  await page.getByText('Exibindo histórico. Esta linha não está ativa.').waitFor();
  await total('202').waitFor();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar CSV' }).click();
  const download = await downloadReady;
  assert.equal(download.suggestedFilename(), 'contagem-vehicle-30d.csv');
  assert.match(fs.readFileSync(await download.path(), 'utf8'), /Entradas;Saídas/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile content overflows horizontally');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `/out/count-review-${width}.png`, fullPage: true });
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try { await scenario(browser, 1440, false); await scenario(browser, 390, true, 'VIEWER'); await scenario(browser, 1440, false, 'VIEWER', false);
    console.log('OK: navigation, playback permission, desktop/mobile, zero-count lines, filters, errors/retry and CSV.'); }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
