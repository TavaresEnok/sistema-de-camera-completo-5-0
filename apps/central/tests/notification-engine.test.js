'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const engine=require('../src/notification-engine'),alerts=require('../src/alertas');
process.env.CENTRAL_STORAGE_SECRET='fixture-only-secret-for-notification-tests';
const BASE=Date.parse('2026-10-05T12:00:00Z');
const minute=60000;
function fixture(id='client') {return {id,customerName:'Loja <Centro>',lastHeartbeatAt:new Date(BASE).toISOString(),alerts:[],alertChannels:alerts.mesclarAlertas({}, {emailEnabled:true,emails:['fixture@example.invalid']})};}
function feed(item,minutes,cameras=[],list=[]){const now=BASE+minutes*minute;item.lastHeartbeatAt=new Date(now).toISOString();item.alerts=list;engine.observe(item,{items:cameras},now);return now;}
const off={cameraId:'camera-1',name:'Entrada <Norte>',status:'OFFLINE'};
const online={...off,status:'ONLINE'};
function deliver(item,now,result={ok:true}){const c=engine.claim(item,now);assert.ok(c);engine.finish(item,c.job,result,now);return c;}

test('camera requires ten minutes of confirmed observations and uses its name',()=>{
 const i=fixture();for(let m=0;m<10;m++)feed(i,m,[off]);assert.equal(i.notifications.jobs.length,0);
 const now=feed(i,10,[off]);const c=deliver(i,now);assert.match(c.job.message.texto,/Entrada <Norte>.*10 minutos/);assert.match(c.job.message.html,/Entrada &lt;Norte&gt;/);
 feed(i,11,[off]);assert.equal(engine.claim(i,BASE+11*minute),null);
});
test('short camera interruption produces neither a warning nor recovery',()=>{
 const i=fixture();feed(i,0,[off]);feed(i,9,[online]);assert.equal(i.notifications.jobs.length,0);
});
test('server absence waits ten minutes; three-minute dashboard threshold stays independent',()=>{
 const i=fixture();engine.observe(i,null,BASE+3*minute);assert.equal(i.notifications.jobs.length,0);
 engine.observe(i,null,BASE+10*minute);const c=deliver(i,BASE+10*minute);assert.match(c.job.message.texto,/10 minutos/);assert.match(c.job.message.texto,/não confirma que as gravações pararam/);
 engine.observe(i,null,BASE+11*minute);assert.equal(engine.claim(i,BASE+11*minute),null);
});
test('never-installed server is not reported as down',()=>{
 const i=fixture();delete i.lastHeartbeatAt;engine.observe(i,null,BASE+1000*minute);assert.equal(i.notifications.jobs.length,0);
});
test('client channel ignores internal services and unknown codes',()=>{
 const i=fixture();feed(i,0,[],[{code:'infra_container',message:'Infra:container:postgres:dead'},{code:'unknown',message:'Redis SQL stack trace'}]);assert.equal(i.notifications.jobs.length,0);
});
test('technical profile is an explicit option',()=>{
 const i=fixture();i.alertChannels.audience='technical';feed(i,0,[],[{code:'infra_container',message:'Infra:container:postgres:dead'}]);assert.match(deliver(i,BASE).job.message.texto,/banco de dados/);
});
test('recovery is positive and only follows a confirmed delivery',()=>{
 const i=fixture();for(let m=0;m<=10;m++)feed(i,m,[off]);deliver(i,BASE+10*minute);const now=feed(i,11,[online]);const c=deliver(i,now);assert.equal(c.job.kind,'recovery');assert.match(c.job.message.texto,/voltou a se comunicar/);assert.doesNotMatch(c.job.message.texto,/está sem comunicação/);
 feed(i,12,[online]);assert.equal(engine.claim(i,BASE+12*minute),null);
});
test('resolved problem cancels unsent warnings, without misleading recovery',()=>{
 const i=fixture();for(let m=0;m<=10;m++)feed(i,m,[off]);const now=feed(i,11,[online]);assert.equal(engine.claim(i,now),null);assert.equal(engine.publicStatus(i).pending,0);
});
test('missing and partial camera reports do not invent recovery',()=>{
 const i=fixture();for(let m=0;m<=10;m++)feed(i,m,[off]);deliver(i,BASE+10*minute);
 feed(i,11,[]);assert.equal(engine.claim(i,BASE+11*minute),null);
 i.lastHeartbeatAt=new Date(BASE+12*minute).toISOString();engine.observe(i,null,BASE+12*minute);assert.equal(engine.claim(i,BASE+12*minute),null);
});
test('unknown and disabled cameras never generate a false online message',()=>{
 const i=fixture();for(let m=0;m<=10;m++)feed(i,m,[off]);deliver(i,BASE+10*minute);
 feed(i,11,[{...off,status:'UNKNOWN'}]);assert.equal(engine.claim(i,BASE+11*minute),null);
 feed(i,12,[{...off,enabled:false}]);assert.equal(engine.claim(i,BASE+12*minute),null);
});
test('time without fresh camera reports is not counted as verified outage',()=>{
 const i=fixture();feed(i,0,[off]);feed(i,9,[off]);assert.equal(i.notifications.jobs.length,0);
 for(let m=10;m<=19;m++)feed(i,m,[off]);assert.ok(engine.claim(i,BASE+19*minute));
});
test('pending queue survives restart and honors requested retry delay',()=>{
 const i=fixture();const disk=[{code:'disk_usage_high',message:'90%'}];feed(i,0,[],disk);
 const c=deliver(i,BASE,{ok:false,retryAfterSeconds:120,erro:'Temporary failure'});
 const restarted=JSON.parse(JSON.stringify(i));assert.equal(engine.claim(restarted,BASE+minute),null);
 assert.ok(engine.claim(restarted,BASE+2*minute));assert.equal(c.job.attempts,1);
});
test('expired worker lease is recovered after restart',()=>{
 const i=fixture();feed(i,0,[],[{code:'disk_usage_high',message:'90%'}]);assert.ok(engine.claim(i,BASE));assert.equal(engine.claim(i,BASE+30000),null);assert.ok(engine.claim(JSON.parse(JSON.stringify(i)),BASE+60001));
});
test('invalid destination stops retries until configuration is corrected',()=>{
 const i=fixture();feed(i,0,[],[{code:'disk_usage_high',message:'90%'}]);deliver(i,BASE,{ok:false,permanent:true,erro:'Invalid destination'});
 feed(i,2,[],[{code:'disk_usage_high',message:'90%'}]);assert.equal(engine.claim(i,BASE+2*minute),null);assert.equal(engine.publicStatus(i).failed,1);
 i.alertChannels.emails=['corrected@example.invalid'];feed(i,3,[],[{code:'disk_usage_high',message:'90%'}]);assert.ok(engine.claim(i,BASE+3*minute));
});
test('destination change cancels old jobs rather than rerouting them',()=>{
 const i=fixture();feed(i,0,[],[{code:'disk_usage_high',message:'90%'}]);i.alertChannels.emails=['other@example.invalid'];assert.equal(engine.claim(i,BASE),null);
});
test('installation queues remain isolated',()=>{
 const a=fixture('a'),b=fixture('b');feed(a,0,[],[{code:'disk_usage_high',message:'90%'}]);feed(b,0,[]);assert.equal(engine.claim(b,BASE),null);assert.equal(engine.claim(a,BASE).installationId,'a');
});
test('delivered incident does not become daily spam after old jobs expire',()=>{
 const i=fixture();feed(i,0,[],[{code:'disk_usage_high',message:'90%'}]);deliver(i,BASE);
 feed(i,1500,[],[{code:'disk_usage_high',message:'91%'}]);feed(i,1501,[],[{code:'disk_usage_high',message:'92%'}]);assert.equal(engine.claim(i,BASE+1501*minute),null);
});
test('warning escalating to critical generates one extra notice',()=>{
 const i=fixture();feed(i,0,[],[{code:'disk_usage_attention',message:'76%'}]);deliver(i,BASE);feed(i,1,[],[{code:'disk_usage_high',message:'90%'}]);const c=deliver(i,BASE+minute);assert.match(c.job.message.texto,/crítico/);
 feed(i,2,[],[{code:'disk_usage_high',message:'91%'}]);assert.equal(engine.claim(i,BASE+2*minute),null);
});
test('repeated outage waits again instead of reusing a previous timer',()=>{
 const i=fixture();for(let m=0;m<=10;m++)feed(i,m,[off]);deliver(i,BASE+10*minute);feed(i,11,[online]);feed(i,12,[off]);assert.equal(engine.claim(i,BASE+12*minute),null);
});
test('category and recovery controls are respected',()=>{
 const i=fixture();i.alertChannels.categories=[];feed(i,0,[],[{code:'disk_usage_high',message:'90%'}]);assert.equal(i.notifications.jobs.length,0);
 i.alertChannels.categories=['disk'];i.alertChannels.avisarRecuperacao=false;feed(i,1,[],[{code:'disk_usage_high',message:'90%'}]);deliver(i,BASE+minute);feed(i,2,[]);assert.equal(engine.claim(i,BASE+2*minute),null);
});
test('public delivery summary contains no destinations, messages or tokens',()=>{
 const i=fixture();feed(i,0,[],[{code:'disk_usage_high',message:'90%'}]);const publicText=JSON.stringify(engine.publicStatus(i));assert.doesNotMatch(publicText,/fixture@example|destination|token|90%/);
});
test('missing disk measurement is not reported as recovered space',()=>{
 const i=fixture();feed(i,0,[],[{code:'disk_usage_high',message:'90%'}]);deliver(i,BASE);feed(i,1,[]);assert.equal(engine.claim(i,BASE+minute),null);
 i.metrics={diskUsagePercent:50};feed(i,2,[]);assert.equal(deliver(i,BASE+2*minute).job.kind,'recovery');
});
test('simultaneous camera notices are grouped, bounded and individually acknowledged',()=>{
 const i=fixture();const cams=Array.from({length:12},(_,n)=>({...off,cameraId:'cam'+n,name:'Câmera '+n}));
 for(let m=0;m<=10;m++)feed(i,m,cams);
 const batch=engine.claimBatch(i,BASE+10*minute);assert.equal(batch.jobs.length,8);assert.match(batch.message.texto,/Câmera 0/);assert.match(batch.message.texto,/Câmera 7/);assert.doesNotMatch(batch.message.texto,/Câmera 8/);
 for(const job of batch.jobs)engine.finish(i,job,{ok:true},BASE+10*minute);
 assert.equal(engine.publicStatus(i).pending,4);
 const second=engine.claimBatch(i,BASE+10*minute);assert.equal(second.jobs.length,4);
});
test('temporary failure stops after eight attempts and exposes attention status',()=>{
 const i=fixture();feed(i,0,[],[{code:'disk_usage_high',message:'90%'}]);let now=BASE;
 for(let n=0;n<8;n++){const c=deliver(i,now,{ok:false,erro:'Temporary failure'});const job=i.notifications.jobs.find(j=>j.id===c.job.id);now=job.dueAt;}
 assert.equal(engine.publicStatus(i).failed,1);assert.equal(engine.publicStatus(i).pending,0);
});
test('successful channel is not resent when a second channel fails',()=>{
 const i=fixture();i.alertChannels=alerts.mesclarAlertas(i.alertChannels,{telegramEnabled:true,telegramChatId:'-100123',telegramBotToken:'123:fixture-only'});
 feed(i,0,[],[{code:'disk_usage_high',message:'90%'}]);let c=engine.claim(i,BASE);assert.equal(c.job.channel,'telegram');engine.finish(i,c.job,{ok:true},BASE);
 c=engine.claim(i,BASE);assert.equal(c.job.channel,'email');engine.finish(i,c.job,{ok:false,erro:'Temporary failure'},BASE);
 feed(i,1,[],[{code:'disk_usage_high',message:'90%'}]);c=engine.claim(i,BASE+minute);assert.equal(c.job.channel,'email');
});
test('successful manual test resumes failed notices only for its verified channel',()=>{
 const i=fixture();feed(i,0,[],[{code:'disk_usage_high',message:'90%'}]);deliver(i,BASE,{ok:false,permanent:true,erro:'Destination blocked'});
 engine.retryConfirmedChannel(i,'telegram',BASE);assert.equal(engine.publicStatus(i).failed,1);
 engine.retryConfirmedChannel(i,'email',BASE);assert.equal(engine.publicStatus(i).pending,1);assert.ok(engine.claim(i,BASE));
});
