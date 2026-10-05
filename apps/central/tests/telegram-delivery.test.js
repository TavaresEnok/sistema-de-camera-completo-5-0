'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.CENTRAL_STORAGE_SECRET='fixture-only-telegram-secret-for-tests';
const alerts=require('../src/alertas');
const config=()=>alerts.mesclarAlertas({}, {telegramEnabled:true,telegramChatId:'-100123',telegramBotToken:'123:fixture-only'});

test('HTTP success alone is not proof that Telegram accepted a message',async t=>{
 t.mock.method(global,'fetch',async()=>({ok:true,status:200,json:async()=>({ok:false,error_code:400,description:'bad request'})}));
 const result=await alerts.enviarTelegram(config(),'test');assert.equal(result.ok,false);assert.equal(result.permanent,true);
});
test('confirmed Telegram response is success',async t=>{
 t.mock.method(global,'fetch',async()=>({ok:true,status:200,json:async()=>({ok:true,result:{message_id:123}})}));
 assert.equal((await alerts.enviarTelegram(config(),'test')).ok,true);
});
test('Telegram rate limit respects retry_after',async t=>{
 t.mock.method(global,'fetch',async()=>({ok:false,status:429,json:async()=>({ok:false,error_code:429,parameters:{retry_after:45}})}));
 const result=await alerts.enviarTelegram(config(),'test');assert.equal(result.ok,false);assert.equal(result.permanent,false);assert.equal(result.retryAfterSeconds,45);
});
test('invalid token and blocked destination require configuration repair',async t=>{
 for(const code of [401,403]){
  const mock=t.mock.method(global,'fetch',async()=>({ok:false,status:code,json:async()=>({ok:false,error_code:code})}));
  const result=await alerts.enviarTelegram(config(),'test');assert.equal(result.permanent,true);mock.mock.restore();
 }
});
test('network errors never expose token or URL in logs/results',async t=>{
 t.mock.method(global,'fetch',async()=>{throw new Error('https://api.telegram.org/bot123:fixture-only/sendMessage');});
 const result=await alerts.enviarTelegram(config(),'test');assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/fixture-only|https|bot123/);
});
test('broken encrypted configuration is reported, not thrown into the worker',async()=>{
 const result=await alerts.enviarTelegram({...config(),telegramBotTokenEncrypted:'x'.repeat(100)},'test');assert.equal(result.ok,false);assert.equal(result.permanent,true);
});
test('shared Central bot is optional and never exposed publicly',async t=>{
 const previous=process.env.CENTRAL_TELEGRAM_BOT_TOKEN;t.after(()=>{if(previous===undefined)delete process.env.CENTRAL_TELEGRAM_BOT_TOKEN;else process.env.CENTRAL_TELEGRAM_BOT_TOKEN=previous;});
 process.env.CENTRAL_TELEGRAM_BOT_TOKEN='123:central-fixture';
 const c=alerts.mesclarAlertas({}, {telegramEnabled:true,botSource:'central',telegramChatId:'-100123'});
 assert.equal(c.telegramEnabled,true);assert.equal(alerts.alertasPublicos(c).centralBotAvailable,true);assert.doesNotMatch(JSON.stringify(alerts.alertasPublicos(c)),/central-fixture/);
 t.mock.method(global,'fetch',async url=>{assert.match(url,/central-fixture/);return {ok:true,status:200,json:async()=>({ok:true})};});
 assert.equal((await alerts.enviarTelegram(c,'test')).ok,true);
});
test('test message is not disguised as a critical incident',()=>{
 const m=alerts.montarMensagem({instalacao:{customerName:'Cliente'},alertas:[{message:'Teste de entrega'}],teste:true});assert.match(m.assunto,/Teste de avisos/);assert.doesNotMatch(m.assunto,/crítico|Atenção/);
});
