const {spawn}=require('node:child_process');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);
process.stdin.on('end',async()=>{
  const config=JSON.parse(input);
  const chrome=spawn('/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
    '--autoplay-policy=no-user-gesture-required','--remote-debugging-port=9224',
    '--remote-debugging-address=127.0.0.1','--user-data-dir=/tmp/drac-video-relay-probe','about:blank'],{stdio:'ignore'});
  let socket;
  try{
    let target;
    for(let i=0;i<40;i++){
      try{target=await (await fetch('http://127.0.0.1:9224/json/new?about:blank',{method:'PUT'})).json();break;}
      catch{await new Promise(r=>setTimeout(r,200));}
    }
    if(!target?.webSocketDebuggerUrl)throw new Error('browser unavailable');
    socket=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
    let id=0;const pending=new Map();
    socket.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){
      const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error('protocol')):p.resolve(m.result);
    }};
    const call=(method,params)=>new Promise((resolve,reject)=>{const key=++id;
      const timer=setTimeout(()=>{pending.delete(key);reject(new Error('timeout'));},(config.seconds+35)*1000);
      pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));});
    await call('Page.navigate',{url:new URL(config.whep).origin});
    await new Promise(r=>setTimeout(r,2000));
    async function probe(url,index){
      const expression=`(async()=>{
        const cfg=${JSON.stringify(config)};
        const pc=new RTCPeerConnection({iceTransportPolicy:'relay',iceServers:[{urls:${JSON.stringify(url)},username:cfg.username,credential:cfg.credential}]});
        const video=document.createElement('video');video.muted=true;video.autoplay=true;document.body.append(video);
        let location;let locationHeaderPresent=false;let deleteStatus=null;let stage='offer';let deleted=false;const began=performance.now();let firstFrameMs=null;let lastFrames=0;let stalledSamples=0;let relayCandidates=0;
        pc.addEventListener('icecandidate',e=>{if(e.candidate?.type==='relay')relayCandidates++;});
        try{
          pc.addTransceiver('video',{direction:'recvonly'});pc.addTransceiver('audio',{direction:'recvonly'});
          pc.ontrack=e=>{video.srcObject=e.streams[0]||new MediaStream([e.track]);video.play().catch(()=>{});};
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise(r=>{if(pc.iceGatheringState==='complete')return r();
            pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete')r();});setTimeout(r,12000);});
          stage='whep';
          const response=await fetch(cfg.whep,{method:'POST',headers:{Authorization:cfg.authorization,'Content-Type':'application/sdp'},
            body:pc.localDescription.sdp,signal:AbortSignal.timeout(10000)});
          if(response.status!==201)return {whepStatus:response.status};
          const header=response.headers.get('Location');locationHeaderPresent=!!header;
          if(header){const resolved=new URL(header,cfg.whep);
            if(resolved.origin!==new URL(cfg.whep).origin||resolved.username||resolved.password)throw new Error('invalid location');
            location=resolved.href;}
          stage='answer';await pc.setRemoteDescription({type:'answer',sdp:await response.text()});
          stage='receive';
          let totals={},selected={};const freezeEvents=[];let lastFreezeCount=0;
          for(let i=0;i<cfg.seconds;i++){
            await new Promise(r=>setTimeout(r,1000));const stats=await pc.getStats();
            for(const s of stats.values())if(s.type==='inbound-rtp'&&s.kind==='video'){
              totals={framesDecoded:s.framesDecoded||0,framesReceived:s.framesReceived||0,framesDropped:s.framesDropped||0,
                packetsLost:s.packetsLost||0,packetsReceived:s.packetsReceived||0,bytesReceived:s.bytesReceived||0,
                jitter:s.jitter,jitterBufferDelay:s.jitterBufferDelay,jitterBufferEmittedCount:s.jitterBufferEmittedCount,
                totalDecodeTime:s.totalDecodeTime,freezeCount:s.freezeCount,totalFreezesDuration:s.totalFreezesDuration};
              if(totals.framesDecoded>0&&firstFrameMs===null)firstFrameMs=Math.round(performance.now()-began);
              if(firstFrameMs!==null&&totals.framesDecoded===lastFrames)stalledSamples++;lastFrames=totals.framesDecoded;
              if((s.freezeCount||0)>lastFreezeCount){if(freezeEvents.length<64)freezeEvents.push({second:i+1,count:s.freezeCount,totalDuration:s.totalFreezesDuration});lastFreezeCount=s.freezeCount;}
            }
            for(const s of stats.values())if(s.type==='transport'&&s.selectedCandidatePairId){
              const pair=stats.get(s.selectedCandidatePairId),local=stats.get(pair?.localCandidateId);
              selected={candidateType:local?.candidateType,relayProtocol:local?.relayProtocol,rtt:pair?.currentRoundTripTime};
            }
          }
          return {whepStatus:201,firstFrameMs,stalledSamples,selected,icePolicy:pc.getConfiguration().iceTransportPolicy,relayCandidates,videoWidth:video.videoWidth,freezeEvents,...totals};
        }catch(e){return {error:e.name,stage};}
        finally{if(location){try{
          const r=await fetch(location,{method:'DELETE',headers:{Authorization:cfg.authorization},signal:AbortSignal.timeout(3000)});deleteStatus=r.status;deleted=r.ok;
        }catch{} }pc.close();video.srcObject=null;video.remove();window.__probeCleanup ||= {};window.__probeCleanup[${index}]={sessionDeleted:deleted,deleteStatus,locationHeaderPresent,
          locationPrefixMatches:location?new URL(location).pathname.startsWith(new URL(cfg.whep).pathname+'/'):null};}
      })()`;
      const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      const cleanup=await call('Runtime.evaluate',{expression:'window.__probeCleanup['+index+']',returnByValue:true});
      if(r.exceptionDetails)throw new Error('evaluation');
      const value=r.result.value;console.log(JSON.stringify({reader:index+1,url,...value,...cleanup.result.value}));
      // A nominated peer-reflexive candidate can still carry relayProtocol.
      // Verify policy, gathered relay and nominated relay transport together.
      if(!value?.framesDecoded||value.icePolicy!=='relay'||!value.relayCandidates||!value.selected?.relayProtocol||!cleanup.result.value?.sessionDeleted)process.exitCode=1;
    }
    await Promise.all(config.urls.map(probe));
  }catch(e){console.error('Video relay probe failed ('+e.name+')');process.exitCode=1;}
  finally{await closeValidationBrowser(chrome,socket);}
});
