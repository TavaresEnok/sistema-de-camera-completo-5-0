// Vibe only. Temporarily change counting FPS on the existing pilot camera,
// verify the UI/runtime and restore the exact original setting in finally.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('/tools/node_modules/playwright-core');
const origin = 'https://vibe.s2cam.com.br';
const cameraId = '8824b0ef-0b82-4a89-90c9-afdf3308865a';

(async () => {
  const credentials = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let original, target, changed = false, headers;
  try {
    const login = await context.request.post(origin + '/api/auth/login', { headers: { 'x-drac-auth-mode': 'cookie' }, data: credentials });
    credentials.password = '';
    assert.equal(login.status(), 201);
    headers = { Authorization: 'Bearer ' + (await login.json()).accessToken };
    const existing = await context.request.get(origin + '/api/cameras/' + cameraId, { headers });
    assert.equal(existing.status(), 200);
    original = (await existing.json()).countingFps ?? null;
    target = original === 12 ? 5 : 12;
    const page = await context.newPage();
    await page.goto(origin + '/alarms?aba=contagem');
    await page.getByRole('combobox', { name: 'O que contar', exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Linha', exact: true }).selectOption(cameraId + '|linha-contagem-porta');
    await page.getByRole('button', { name: 'Atualizar contagem', exact: true }).waitFor({ state: 'visible' });
    await page.goto(origin + '/perimetro?cameraId=' + cameraId);
    const request = page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/cameras/' + cameraId, { timeout: 90000 });
    await page.getByRole('button', { name: `${target} q/s`, exact: true }).click();
    changed = true;
    const applied = await request;
    assert.equal(applied.status(), 200);
    const result = await applied.json();
    assert.equal(result.countingFps, target);
    assert.ok(['started', 'running', 'already_running'].includes(result.aiApplyStatus));
    const health = await context.request.get(origin + '/api/ai/health', { headers });
    const processor = (await health.json()).processors[cameraId];
    assert.equal(processor.counting.fps, target);
    assert.equal(processor.counting.durableState, true);
    await page.reload();
    await page.getByRole('button', { name: `${target} q/s`, exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: `${target} q/s`, exact: true }).getAttribute('aria-pressed'), 'true');
    console.log(JSON.stringify({ target: origin, report: true, countingFpsApplied: target, runtimeFpsVerified: true, reloadPreservedSelection: true, durableState: true }));
  } finally {
    try {
      if (changed && headers) {
        const current = await (await context.request.get(origin + '/api/cameras/' + cameraId, { headers })).json();
        if (current.countingFps === target) {
          const restored = await context.request.patch(origin + '/api/cameras/' + cameraId, { headers, data: { countingFps: original } });
          assert.equal(restored.status(), 200);
          assert.equal((await restored.json()).countingFps, original);
          console.log(JSON.stringify({ originalCountingFpsRestored: original }));
        } else {
          console.log('FPS changed concurrently; preserving the newer setting.');
        }
      }
    } finally { await context.close(); await browser.close(); }
  }
})().catch(e => { console.error(e.name + ': ' + e.message); process.exitCode = 1; });
