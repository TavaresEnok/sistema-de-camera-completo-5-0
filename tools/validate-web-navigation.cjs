const {spawn}=require('node:child_process');
const fs=require('node:fs');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);
process.stdin.on('end',async()=>{
 const cfg=JSON.parse(input), sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const chrome=spawn('/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--incognito',
  '--autoplay-policy=no-user-gesture-required','--remote-debugging-port=9225','--remote-debugging-address=127.0.0.1',
  '--user-data-dir=/tmp/drac-navigation-validation','about:blank'],{stdio:'ignore'});
 let ws;const pending=new Map();let seq=0, exceptions=0, failedRequests=0;
 try{
  let target;for(let i=0;i<40;i++){try{target=await(await fetch('http://127.0.0.1:9225/json/new?about:blank',{method:'PUT'})).json();break;}catch{await sleep(200);}}
  if(!target?.webSocketDebuggerUrl)throw new Error('browser');
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('protocol timeout'));},30000);
   pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  const responses={}, requests={};
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error('protocol')):p.resolve(m.result);return;}
   if(m.method==='Fetch.requestPaused'){
    call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'},
     {name:'Cache-Control',value:'no-store'}],body:Buffer.from(JSON.stringify(cfg.auth)).toString('base64')}).catch(()=>{});
   }
   if(m.method==='Runtime.exceptionThrown')exceptions++;
   if(m.method==='Network.loadingFailed'&&!m.params.canceled)failedRequests++;
   if(m.method==='Network.requestWillBeSent'){
    const u=new URL(m.params.request.url);let type=u.pathname.includes('/detections')?'detections':u.pathname.includes('/ai/health')?'ai-health':u.pathname.endsWith('/whep')?'whep':null;
    if(type)requests[type]=(requests[type]||0)+1;
   }
   if(m.method==='Network.responseReceived'){const status=m.params.response.status;if(status>=400)responses[status]=(responses[status]||0)+1;}
  };
  await call('Page.enable');await call('Network.enable');await call('Runtime.enable');await call('Performance.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await call('Fetch.enable',{patterns:[{urlPattern:cfg.origin+'/api/auth/refresh',requestStage:'Request'}]});
  const init=`(()=>{const u=${JSON.stringify(cfg.auth.user)};
   localStorage.setItem('nexusguard.auth.user',JSON.stringify({...u,role:'admin'}));
   localStorage.setItem('drac.live.grid.v1.'+u.id,JSON.stringify({gridSize:'2x2',cameraIds:${JSON.stringify(cfg.cameraIds)}}));
    localStorage.removeItem('nexusguard.auth.logout-at');
   const Native=window.RTCPeerConnection;window.__validationPeers=[];window.__validationPeerCount=0;
   window.RTCPeerConnection=class extends Native{constructor(...a){super(...a);window.__validationPeerCount++;window.__validationPeers.push(new WeakRef(this));}};
  })()`;
  await call('Page.addScriptToEvaluateOnNewDocument',{source:init});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error('evaluation');return r.result.value;};
  const sample=async label=>{
   const m=await evaluate(`(()=>{const peers=window.__validationPeers.map(r=>r.deref()).filter(Boolean);const videos=[...document.querySelectorAll('video')];return {path:location.pathname,videos:videos.length,
    playing:[...document.querySelectorAll('video')].filter(v=>v.videoWidth>0&&!v.paused).length,
    totalVideoFrames:videos.reduce((n,v)=>n+(v.getVideoPlaybackQuality?.().totalVideoFrames||0),0),
    droppedVideoFrames:videos.reduce((n,v)=>n+(v.getVideoPlaybackQuality?.().droppedVideoFrames||0),0),
    peers:window.__validationPeerCount,openPeers:peers.filter(p=>p.connectionState!=='closed').length,
    connectedPeers:peers.filter(p=>p.connectionState==='connected').length,
    retainedGrid:!!document.querySelector('[aria-hidden="true"] video'),simButton:[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Simular regras nesta câmera'))};})()`);
   const metrics=await call('Performance.getMetrics');const keep=new Set(['JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents','JSEventListeners','LayoutCount','TaskDuration']);
   console.log(JSON.stringify({label,...m,metrics:Object.fromEntries(metrics.metrics.filter(x=>keep.has(x.name)).map(x=>[x.name,x.value])),exceptions,failedRequests,httpErrors:responses,requests}));
   return m;
  };
  const route=path=>evaluate(`history.pushState(null,'',${JSON.stringify(path)});dispatchEvent(new PopStateEvent('popstate'));true`);
  await call('Page.navigate',{url:cfg.origin+'/live'});await sleep(20000);const first=await sample('grid-initial');
  if(first.playing<1||first.connectedPeers<1)throw new Error('no grid video');
  if(cfg.soakSeconds){
   // Observer has no effect on production config. Abort this browser's load
   // after sustained host pressure; never kill/restart a production service.
   const cpu=()=>{const v=fs.readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number);return {total:v.reduce((n,x)=>n+x,0),idle:v[3]+v[4]};};
   let previous=cpu(),overloaded=0,lastFrames=first.totalVideoFrames;const began=Date.now();let samples=0;
   while(Date.now()-began<cfg.soakSeconds*1000){
    await sleep(10000);const now=cpu();const busy=100*(1-(now.idle-previous.idle)/Math.max(1,now.total-previous.total));previous=now;
    overloaded=busy>75?overloaded+10:0;
    const available=Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo','utf8'))?.[1]);
    if(overloaded>=20||available<512*1024)throw Error('safety stop: host resource pressure');
    if(++samples%6===0){const state=await sample('grid-soak-'+Math.round((Date.now()-began)/1000));
     if(state.playing<cfg.cameraIds.length||state.totalVideoFrames<=lastFrames)throw Error('grid video stopped progressing');lastFrames=state.totalVideoFrames;}
   }
   await route('/profile');await sleep(70000);const final=await sample('soak-cleanup');
   if(final.openPeers!==0)throw Error('soak cleanup leaked players');
   console.log(JSON.stringify({summary:'passed',soakSeconds:cfg.soakSeconds}));return;
  }
  // Same SPA tree: wait past the intentional 60-second retained-live grace.
  for(let cycle=1;cycle<=3;cycle++){
   await route('/perimetro?cameraId='+cfg.manualId);await sleep(12000);await sample('perimeter-'+cycle);
   if(cycle===1){
    const clicked=await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Simular regras nesta câmera'));if(!b||b.disabled)return false;b.click();return true;})()`);
    await sleep(20000);await sample('manual-camera-motion-simulation');
    if(!clicked)throw new Error('simulation unavailable');
    await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Voltar ao desenho'));b?.click();return !!b;})()`);
   }
   await route('/cameras?cameraId='+cfg.manualId);await sleep(12000);await sample('camera-page-'+cycle);
   await route('/profile');await sleep(70000);const clean=await sample('past-grid-grace-'+cycle);
   if(clean.openPeers!==0)throw new Error('players remain after grace');
   await route('/live');await sleep(15000);await sample('grid-return-'+cycle);
  }
  // Simulate an offline browser, not interruption of a production service.
  await call('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await sleep(5000);
  await call('Network.emulateNetworkConditions',{offline:false,latency:80,downloadThroughput:625000,uploadThroughput:125000});
  await sleep(25000);await sample('browser-network-recovery');
  await route('/profile');await sleep(70000);const final=await sample('final-cleanup');
  if(final.openPeers!==0)throw new Error('final leak');
 }catch(e){console.error(JSON.stringify({validationError:e.message}));process.exitCode=1;}
 finally{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('closed'));}ws?.close();chrome.kill('SIGTERM');}
});
