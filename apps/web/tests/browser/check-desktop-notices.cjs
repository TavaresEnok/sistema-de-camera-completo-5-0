// Run with PLAYWRIGHT_MODULE pointing to an installed playwright-core module.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async()=>{
  const bundle=fs.readFileSync(process.argv[2]);
  const css=process.argv[3]?fs.readFileSync(process.argv[3]):'';
  const server=http.createServer((req,res)=>{
    if(req.url==='/fixture.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle);}
    else if(req.url==='/fixture.css'){res.setHeader('Content-Type','text/css');res.end(css);}
    else {res.setHeader('Content-Type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated desktop alert test</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const context=await browser.newContext({permissions:['notifications']});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/live?display=aux-1');
    await page.getByRole('button',{name:'Avisos ativos — Portaria'}).click();
    await page.getByRole('menuitem',{name:'Pausar avisos',exact:true}).click();
    await page.getByRole('button',{name:'Avisos pausados manualmente — Portaria'}).waitFor();
    await page.getByRole('button',{name:'Avisos pausados manualmente — Portaria'}).click();
    await page.getByRole('menuitem',{name:'Seguir programação',exact:true}).click();
    await page.getByRole('button',{name:'Avisos ativos — Portaria'}).click();
    await page.getByRole('menuitem',{name:'Horários...'}).click();
    await page.getByLabel('Programação',{exact:true}).selectOption('periods');
    assert.equal(await page.getByLabel('Fuso horário',{exact:true}).isVisible(),false);
    assert.equal(await page.getByLabel('Controle manual',{exact:true}).isVisible(),false);
    await page.getByRole('button',{name:'Dom do período 1',exact:true}).click();
    await page.getByText('Mais opções',{exact:true}).click();
    await page.getByLabel('Fuso horário',{exact:true}).selectOption('America/Manaus');
    await page.getByText('Mais opções',{exact:true}).click();
    await page.getByLabel('Início do período 1').fill('20:30');
    if(process.env.TEST_SCREENSHOT_DIR){
      await page.screenshot({path:process.env.TEST_SCREENSHOT_DIR+'/schedule-desktop.png'});
      await page.setViewportSize({width:375,height:812});
      await page.screenshot({path:process.env.TEST_SCREENSHOT_DIR+'/schedule-mobile.png'});
      assert.equal(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      await page.setViewportSize({width:1280,height:720});
    }
    await page.getByRole('button',{name:'Salvar',exact:true}).click();
    await page.waitForFunction(()=>window.policies().camera.policy.schedule?.periods[0]?.start==='20:30');
    assert.equal(await page.evaluate(()=>window.policies().group.policy.schedule.mode),'always');
    assert.equal(await page.evaluate(()=>window.policies().camera.policy.schedule.timezone),'America/Manaus');
    assert.equal(await page.evaluate(()=>window.policies().camera.policy.schedule.periods[0].days.includes(0)),false);
    await page.getByRole('button',{name:'Horários dos avisos',exact:true}).click();
    await page.getByLabel('Programação',{exact:true}).selectOption('off');
    await page.getByRole('button',{name:'Salvar',exact:true}).click();
    await page.waitForFunction(()=>window.policies().group.policy.schedule.mode==='off');
    assert.equal(await page.evaluate(()=>window.policies().camera.policy.schedule.periods[0].start),'20:30');
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
    await page.evaluate(()=>window.pause());
    await page.evaluate(()=>window.notifications[1].dispatchEvent(new Event('click')));
    assert.equal(await page.getByTestId('fixture-video').count(),0);
    await page.evaluate(()=>window.revokeCamera());
    await page.evaluate(()=>window.notifications[1].dispatchEvent(new Event('click')));
    assert.equal(await page.getByTestId('fixture-video').count(),0);
    await page.evaluate(()=>window.logout());
    await page.evaluate(()=>window.notifications[1].dispatchEvent(new Event('click')));
    assert.equal(await page.getByTestId('fixture-video').count(),0);
    assert.equal(page.url(),origin+'/live?display=aux-1');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({realChromium:true,individualCameraSchedulePersists:true,groupEditsPreserveCameraOverride:true,quickPauseAndResume:true,pausedNotificationClickBlocked:true,nativeNotificationPermission:true,clickOpensMatchingCamera:true,currentUrlPreserved:true,revokedAccessBlocked:true,loggedOutClickBlocked:true,pageErrors:errors}));
    await context.close();
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
