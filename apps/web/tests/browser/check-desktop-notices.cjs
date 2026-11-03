// Run with PLAYWRIGHT_MODULE pointing to an installed playwright-core module.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async()=>{
  const bundle=fs.readFileSync(process.argv[2]);
  const server=http.createServer((req,res)=>{
    if(req.url==='/fixture.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle);}
    else {res.setHeader('Content-Type','text/html');res.end('<html><head><title>Isolated desktop alert test</title></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const context=await browser.newContext({permissions:['notifications']});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/live?display=aux-1');
    await page.getByRole('button',{name:'Configurar notificações no computador'}).click();
    await page.getByRole('button',{name:'Ativar notificações',exact:true}).click();
    await page.waitForFunction(()=>window.preference());
    await page.keyboard.press('Escape');
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});window.emit();});
    await page.waitForFunction(()=>window.notifications.length===1);
    await page.evaluate(()=>window.notifications[0].dispatchEvent(new Event('click')));
    await page.getByTestId('fixture-video').waitFor();
    assert.equal(await page.getByTestId('fixture-video').getAttribute('data-camera-id'),'fixture-camera');
    assert.equal(page.url(),origin+'/live?display=aux-1');
    await page.getByRole('button',{name:'Fechar câmera',exact:true}).click();
    await page.evaluate(()=>window.emit());
    await page.waitForFunction(()=>window.notifications.length===2);
    await page.evaluate(()=>window.revokeCamera());
    await page.evaluate(()=>window.notifications[1].dispatchEvent(new Event('click')));
    assert.equal(await page.getByTestId('fixture-video').count(),0);
    await page.evaluate(()=>window.logout());
    await page.evaluate(()=>window.notifications[1].dispatchEvent(new Event('click')));
    assert.equal(await page.getByTestId('fixture-video').count(),0);
    assert.equal(page.url(),origin+'/live?display=aux-1');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({realChromium:true,nativeNotificationPermission:true,clickOpensMatchingCamera:true,currentUrlPreserved:true,revokedAccessBlocked:true,loggedOutClickBlocked:true,pageErrors:errors}));
    await context.close();
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
