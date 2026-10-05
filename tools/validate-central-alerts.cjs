// UI validation against an isolated, no-public-port Central container.
const {chromium}=require('/tmp/browser/node_modules/playwright-core');
(async()=>{
 const base='http://drac-alerts-preview-20261005:9765';
 const headers={authorization:'Bearer fixture-alerts-preview-not-production','content-type':'application/json'};
 const created=await fetch(base+'/api/admin/provision',{method:'POST',headers,body:JSON.stringify({installationId:'alerts-preview',customerName:'Cliente de teste'})});
 if(![200,201].includes(created.status))throw new Error('Isolated fixture provisioning failed');
 if(created.status===200)await fetch(base+'/api/admin/installations/alerts-preview/alertas',{method:'PATCH',headers,body:JSON.stringify({alertas:{cameraDelayMinutes:10,serverDelayMinutes:10}})});
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1050}});await page.setExtraHTTPHeaders(headers);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.locator('tr[data-id="alerts-preview"]').first().click();
  await page.locator('button[data-tab="alertas"]').click();
  await page.locator('#alertas-audience').waitFor({state:'visible'});
  if(await page.locator('#alertas-camera-delay').inputValue()!=='10'||await page.locator('#alertas-server-delay').inputValue()!=='10')throw new Error('Default ten-minute controls missing');
  await page.locator('#alertas-camera-delay').fill('12');
  await page.locator('#alertas-salvar').click();
  await page.waitForFunction(()=>document.querySelector('#alertas-feedback')?.textContent==='Destinos salvos.');
  const items=await (await fetch(base+'/api/admin/installations',{headers})).json();
  const config=items.items.find(i=>i.id==='alerts-preview').alertas;
  if(config.cameraDelayMinutes!==12||config.audience!=='customer')throw new Error('UI save did not reach server');
  await page.screenshot({path:'/tmp/central-alerts-v2.png',fullPage:true});
  if(errors.length)throw new Error('UI raised script errors: '+errors.join(';'));
  console.log(JSON.stringify({isolated:true,scriptErrors:0,preferencesSaved:true,defaultServerDelayMinutes:config.serverDelayMinutes,customerMode:config.audience,realRecipientsConfigured:false}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
