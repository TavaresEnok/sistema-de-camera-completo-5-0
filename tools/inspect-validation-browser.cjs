// Read counters from our existing diagnostic Chromium, never a customer's tab.
(async()=>{
 const targets=await(await fetch('http://127.0.0.1:9225/json/list')).json();
 const target=targets.find(t=>t.type==='page'&&t.url.startsWith('https://vibe.s2cam.com.br/'));
 if(!target)throw Error('Diagnostic page unavailable');
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 const expression=`(async()=>{
 const peers=(window.__validationPeers||[]).map(r=>r.deref()).filter(p=>p&&p.connectionState==='connected');const results=[];
 for(const pc of peers){const stats=await pc.getStats();for(const s of stats.values())if(s.type==='inbound-rtp'&&s.kind==='video'){
 results.push({framesDecoded:s.framesDecoded,framesReceived:s.framesReceived,framesDropped:s.framesDropped,packetsLost:s.packetsLost,
 freezeCount:s.freezeCount,totalFreezesDuration:s.totalFreezesDuration,totalDecodeTime:s.totalDecodeTime,jitter:s.jitter,
 jitterBufferDelay:s.jitterBufferDelay,jitterBufferEmittedCount:s.jitterBufferEmittedCount});}}
 return {scope:'diagnostic browser only',peers:results,videos:[...document.querySelectorAll('video')].map(v=>({width:v.videoWidth,height:v.videoHeight,
 totalFrames:v.getVideoPlaybackQuality?.().totalVideoFrames,droppedFrames:v.getVideoPlaybackQuality?.().droppedVideoFrames,playing:!v.paused}))};
 })()`;
 const timer=setTimeout(()=>{ws.close();process.exitCode=1;},10000);
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id!==1)return;clearTimeout(timer);
 if(m.error||m.result.exceptionDetails){console.error('Inspection failed');process.exitCode=1;}else console.log(JSON.stringify(m.result.result.value));ws.close();};
 ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
})().catch(()=>{console.error('Diagnostic browser unavailable');process.exitCode=1;});
