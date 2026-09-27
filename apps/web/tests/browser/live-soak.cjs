// Homologação com câmeras reais. Não cria usuário, não altera câmeras nem gravações.
// LIVE_SOAK_URL: URL HTTPS da grade já preparada (36 ou 64 câmeras).
// LIVE_SOAK_AUTH_STATE: storageState do Playwright, guardado FORA do Git, chmod 600.
// LIVE_SOAK_SECONDS: 1800 por padrão. Saída NDJSON contém apenas métricas agregadas.
const { chromium } = require('playwright');
(async () => {
  const url = new URL(process.env.LIVE_SOAK_URL || '');
  if (url.protocol !== 'https:') throw new Error('Use HTTPS para o teste real');
  if (!process.env.LIVE_SOAK_AUTH_STATE) throw new Error('Forneça uma sessão de teste autorizada');
  const seconds = Number(process.env.LIVE_SOAK_SECONDS || 1800);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 86400) throw new Error('Duração inválida');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  let pageErrors = 0;
  try {
    const context = await browser.newContext({ storageState: process.env.LIVE_SOAK_AUTH_STATE, viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    page.on('pageerror', () => { pageErrors++; });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(url.toString());
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.readyState >= 2), undefined, { timeout: 90000 });
    const started = Date.now();
    while (Date.now() - started < seconds * 1000) {
      const video = await page.evaluate(() => {
        const videos = [...document.querySelectorAll('video')];
        return videos.reduce((sum, v) => {
          const q = v.getVideoPlaybackQuality?.();
          sum.elements++; sum.playing += Number(!v.paused && v.readyState >= 2);
          sum.totalFrames += q?.totalVideoFrames || 0;
          sum.droppedFrames += q?.droppedVideoFrames || 0;
          return sum;
        }, { elements: 0, playing: 0, totalFrames: 0, droppedFrames: 0 });
      });
      const { metrics } = await cdp.send('Performance.getMetrics');
      const selected = Object.fromEntries(metrics.filter(m => ['JSHeapUsedSize', 'Nodes', 'Documents', 'TaskDuration', 'ScriptDuration'].includes(m.name)).map(m => [m.name, m.value]));
      console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), pageErrors, ...video, ...selected }));
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.name); process.exitCode = 1; });
