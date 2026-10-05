'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs/promises');
const {startCentral}=require('./helpers/central-server');
async function fixture(t,extra={}){
 const c=await startCentral({CENTRAL_STORAGE_SECRET:'fixture-only-key-for-HTTP-notifications',NODE_OPTIONS:'--require '+path.resolve(__dirname,'helpers/fake-telegram.cjs'),DRAC_CENTRAL_NOTIFICATION_INTERVAL_MS:'1000',...extra});t.after(()=>c.stop());
 const p=await fetch(c.base+'/api/admin/provision',{method:'POST',headers:c.adminHeaders(),body:JSON.stringify({installationId:'notify',customerName:'Fixture'})});assert.equal(p.status,201);
 const disk=JSON.parse(await fs.readFile(path.join(c.dir,'installations.json'),'utf8'));
 return {...c,key:disk.installations.notify.licenseKey};
}
async function configure(c,extra={}){return fetch(c.base+'/api/admin/installations/notify/alertas',{method:'PATCH',headers:c.adminHeaders(),body:JSON.stringify({alertas:{telegramEnabled:true,telegramChatId:'-100123',telegramBotToken:'123:fixture-only',...extra}})});}
async function heartbeat(c,body){return fetch(c.base+'/api/agent/heartbeat',{method:'POST',headers:{'content-type':'application/json','X-DRAC-Installation-Id':'notify','X-DRAC-License-Key':c.key},body:JSON.stringify(body)});}
async function waitFor(fn){const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Fixture state deadline exceeded');}

test('HTTP saves preferences, queues authenticated alerts and confirms delivery durably',async t=>{
 const c=await fixture(t);assert.equal((await configure(c)).status,200);
 assert.equal((await heartbeat(c,{summary:{diskUsagePercent:90},alerts:[{code:'disk_usage_high',message:'90%'}]})).status,200);
 await waitFor(async()=>{const d=JSON.parse(await fs.readFile(path.join(c.dir,'installations.json'),'utf8'));return d.installations.notify.notifications?.jobs.some(j=>j.status==='sent');});
 const r=await fetch(c.base+'/api/admin/installations',{headers:c.adminHeaders()});const d=await r.json(),i=d.items.find(x=>x.id==='notify');
 assert.equal(i.alertas.audience,'customer');assert.equal(i.alertas.cameraDelayMinutes,10);assert.equal(i.alertas.serverDelayMinutes,10);assert.equal(i.alertas.delivery.lastDelivery.status,'sent');
 assert.doesNotMatch(JSON.stringify(i),/123:fixture-only|telegramBotTokenEncrypted/);
 const attempts=c.logs.filter(s=>s.includes('[telegram-fixture]')).length;assert.equal(attempts,1);
});
test('invalid waiting periods and unavailable shared bot are refused',async t=>{
 const c=await fixture(t);assert.equal((await configure(c,{cameraDelayMinutes:0})).status,400);assert.equal((await configure(c,{serverDelayMinutes:1.5})).status,400);assert.equal((await configure(c,{botSource:'central'})).status,400);
});
test('manual send test cannot block fleet requests or overwrite a changed destination',async t=>{
 const c=await fixture(t,{TEST_TELEGRAM_DELAY_MS:'1200'});assert.equal((await configure(c)).status,200);
 const pending=fetch(c.base+'/api/admin/installations/notify/alertas/teste',{method:'POST',headers:c.adminHeaders(),body:'{}'});
 await waitFor(()=>c.logs.some(s=>s.includes('[telegram-fixture]')));
 const start=Date.now();assert.equal((await configure(c,{telegramChatId:'-100456'})).status,200);assert.ok(Date.now()-start<1000,'Slow messaging request held the datastore gate');
 assert.equal((await pending).status,409);
 const d=JSON.parse(await fs.readFile(path.join(c.dir,'installations.json'),'utf8'));assert.equal(d.installations.notify.alertChannels.telegramChatId,'-100456');assert.equal(d.installations.notify.alertChannels.ultimoTesteOk,null);
});
