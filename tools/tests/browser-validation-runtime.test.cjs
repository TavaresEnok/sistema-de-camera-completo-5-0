const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {closeValidationBrowser}=require('../browser-validation-runtime.cjs');
function child(){const c=new EventEmitter();c.exitCode=null;c.signalCode=null;c.signals=[];
  c.kill=s=>{c.signals.push(s);if(s==='SIGKILL'){c.signalCode=s;c.emit('exit');}};return c;}
const opts={graceMs:2,termMs:2,killMs:2,reapMs:0};
test('graceful browser close precedes socket teardown and avoids signals',async()=>{
  const c=child();let closed=false;
  const socket={readyState:1,send(message){assert.equal(JSON.parse(message).method,'Browser.close');assert.equal(closed,false);c.exitCode=0;c.emit('exit');},close(){closed=true;}};
  await closeValidationBrowser(c,socket,opts);assert.equal(closed,true);assert.deepEqual(c.signals,[]);
});
test('a stuck owned browser escalates with bounded waits',async()=>{
  const c=child();await closeValidationBrowser(c,null,opts);assert.deepEqual(c.signals,['SIGTERM','SIGKILL']);
});
test('an exited child is never signaled again',async()=>{
  const c=child();c.signalCode='SIGTERM';await closeValidationBrowser(c,null,opts);assert.deepEqual(c.signals,[]);
});
