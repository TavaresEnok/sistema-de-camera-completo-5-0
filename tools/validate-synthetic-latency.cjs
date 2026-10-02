// Isolated clock-watermarked video; no customer images or authentication.
const {spawn}=require('node:child_process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const chrome=spawn('/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
  '--autoplay-policy=no-user-gesture-required','--unsafely-treat-insecure-origin-as-secure=http://drac-validation-sink:8889',
  '--remote-debugging-port=9226','--remote-debugging-address=127.0.0.1',
  '--user-data-dir=/tmp/synthetic-clock','about:blank'],{stdio:'ignore'});let ws;
 try{
  let target;for(let i=0;i<40;i++){try{target=await(await fetch('http://127.0.0.1:9226/json/new?about:blank',{method:'PUT'})).json();break;}catch{await sleep(200);}}
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error('protocol')):p.resolve(m.result);}};
  const call=(method,params)=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('timeout'));},90000);pending.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}));});
  await call('Page.navigate',{url:'http://drac-validation-sink:8889/'});await sleep(1000);
  const expression=`(async()=>{
   const sleep=ms=>new Promise(r=>setTimeout(r,ms));
   const pc=new RTCPeerConnection();pc.addTransceiver('video',{direction:'recvonly'});
   const v=document.createElement('video');v.autoplay=true;v.muted=true;document.body.append(v);
   const c=document.createElement('canvas');c.width=640;c.height=360;const ctx=c.getContext('2d',{willReadFrequently:true});
   const ages=[];let invalid=0,session;let stopped=false;
   pc.ontrack=e=>{v.srcObject=e.streams[0]||new MediaStream([e.track]);v.play().catch(()=>{});};
   function sample(){if(stopped)return;if(v.videoWidth){ctx.drawImage(v,0,0,640,360);const pixels=ctx.getImageData(0,16,640,1).data;let stamp=0;
    for(let i=0;i<48;i++)stamp=stamp*2+(pixels[(16+i*12)*4]>128?1:0);
    const age=Date.now()-stamp;if(age>=0&&age<10000)ages.push(age);else invalid++;}v.requestVideoFrameCallback(sample);}
   try{
    await pc.setLocalDescription(await pc.createOffer());await new Promise(r=>{if(pc.iceGatheringState==='complete')return r();pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')r();};setTimeout(r,3000);});
    const endpoint='http://drac-validation-sink:8889/live/validation/whep';const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/sdp'},body:pc.localDescription.sdp});
    if(r.status!==201)throw Error('WHEP status '+r.status);session=new URL(r.headers.get('Location'),endpoint).href;
    await pc.setRemoteDescription({type:'answer',sdp:await r.text()});await sleep(5000);v.requestVideoFrameCallback(sample);await sleep(30000);
    ages.sort((a,b)=>a-b);const stats=await pc.getStats();let inbound={};for(const s of stats.values())if(s.type==='inbound-rtp'&&s.kind==='video')inbound={framesDecoded:s.framesDecoded,framesDropped:s.framesDropped,packetsLost:s.packetsLost,freezeCount:s.freezeCount};
    return {scope:'synthetic generation -> encode -> SRS -> MediaMTX -> rendered browser frame, same host',samples:ages.length,invalid,
     median_ms:ages[Math.floor(ages.length*.5)],p95_ms:ages[Math.floor(ages.length*.95)],max_ms:ages.at(-1),...inbound};
   }finally{stopped=true;if(session)await fetch(session,{method:'DELETE'}).catch(()=>{});pc.close();v.srcObject=null;v.remove();}
  })()`;
  const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||'evaluation');
  console.log(JSON.stringify(r.result.value));if(!r.result.value.samples)process.exitCode=1;
 }catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
 finally{ws?.close();chrome.kill('SIGTERM');}
})();
