// Browser validation; password is supplied over stdin, never in a file/argv.
const fs = require('node:fs');
const { chromium } = require('/tmp/browser/node_modules/playwright-core');

(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('https://dguardian.s2cam.com.br/', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('input-username').fill('admin');
    await page.getByTestId('input-password').fill(input.password);
    await page.getByTestId('button-login').click();
    const logo = page.locator('.sidebar-brand img');
    await logo.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('.sidebar-brand img')?.naturalWidth > 0);
    const desktop = await logo.evaluate(img => ({ height: img.getBoundingClientRect().height,
      width: img.getBoundingClientRect().width, fit: getComputedStyle(img).objectFit,
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }));
    // The container's 1px border leaves 78px inside its 80px height.
    if (desktop.height < 78 || desktop.height > 80 || desktop.fit !== 'contain') throw new Error('Desktop logo sizing failed: '+JSON.stringify(desktop));
    await page.locator('.sidebar-shell').screenshot({ path: '/tmp/dguardian-sidebar-logo-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(750);
    const mobile = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth,
      logoHeight: document.querySelector('.sidebar-brand img')?.getBoundingClientRect().height }));
    if (mobile.overflow || mobile.logoHeight < 30 || mobile.logoHeight > 32) throw new Error('Mobile sidebar overflow/sizing failed: '+JSON.stringify(mobile));
    console.log(JSON.stringify({ loginVerified: true, desktop, mobile, screenshot: '/tmp/dguardian-sidebar-logo-desktop.png' }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('button-logout').click();
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
