// Executar com Playwright instalado e LIVE_BROWSER_BASE apontando ao Vite de laboratório.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const results = [];
  try {
    for (const fallback of [false, true]) {
      const context = await browser.newContext();
      if (fallback) await context.addInitScript(() => { window.BroadcastChannel = undefined; });
      const open = async (display, user = 'test') => {
        const page = await context.newPage();
        await page.goto(`${process.env.LIVE_BROWSER_BASE}/tests/browser/live-displays.html?display=${display}&user=${user}`);
        await page.waitForFunction(() => window.testLive);
        return page;
      };
      const main = await open('main');
      const aux = await open('aux-1');
      await main.evaluate(() => window.testLive.add('camera-a'));
      await aux.waitForFunction(() => window.testLive.snapshot().displays.main?.cameraIds.includes('camera-a'));
      assert.equal(await aux.evaluate(() => window.testLive.move('main', 'camera-a')), true);
      await main.waitForFunction(() => !window.testLive.snapshot().cameraIds.includes('camera-a'));
      await aux.waitForFunction(() => window.testLive.snapshot().cameraIds.includes('camera-a'));
      results.push(`transferência com confirmação: ${fallback ? 'storage' : 'BroadcastChannel'}`);
      const anotherUser = await open('aux-2', 'other-user');
      await anotherUser.evaluate(() => window.testLive.add('camera-a'));
      await anotherUser.waitForFunction(() => window.testLive.snapshot().cameraIds.includes('camera-a'));
      assert.equal(await anotherUser.evaluate(() => Object.keys(window.testLive.snapshot().displays).length), 1);
      results.push('isolamento entre usuários');
      await main.evaluate(() => window.testLive.add('camera-closed'));
      await aux.waitForFunction(() => window.testLive.snapshot().displays.main?.cameraIds.includes('camera-closed'));
      await main.close();
      assert.equal(await aux.evaluate(() => window.testLive.move('main', 'camera-closed')), false);
      assert.equal(await aux.evaluate(() => window.testLive.snapshot().cameraIds.includes('camera-closed')), false);
      results.push('origem fechada: timeout sem duplicar câmera');
      const duplicate = await open('aux-1');
      await aux.waitForFunction(() => window.testLive.snapshot().superseded);
      assert.equal(await duplicate.evaluate(() => window.testLive.snapshot().superseded), false);
      results.push('janela duplicada substitui a anterior');
      await context.close();
    }
    console.log(JSON.stringify({ browser: await browser.version(), passed: results.length, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
