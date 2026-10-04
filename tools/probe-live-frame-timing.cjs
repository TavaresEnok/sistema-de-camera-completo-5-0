// Read-only encoded-packet timing. No decoded images or credentials are saved.
const {spawnWithSecretUrl}=require('/app/apps/api/dist/common/process/secret-url-process.helper.js');
const auth={Authorization:'Basic '+Buffer.from(process.env.MEDIAMTX_API_USER+':'+process.env.MEDIAMTX_API_PASS).toString('base64')};
(async()=>{
 const response=await fetch('http://mediamtx:9997/v3/paths/list',{headers:auth});
 if(!response.ok)throw new Error('media_control_unavailable');
 const paths=(await response.json()).items;
 const preferred=process.env.PROBE_CAMERA_ID;
 const grid=paths.find(x=>preferred ? x.name==='cam_'+preferred.replaceAll('-','')+'_grid' : x.ready&&x.name.endsWith('_grid'));
 if(!grid)throw new Error('no_ready_grid');
 const prefix=grid.name.slice(0,-5);
 const raw=paths.find(x=>x.name.startsWith(prefix+'_raw_'));
 await Promise.all([grid,raw].filter(Boolean).map(path=>new Promise(resolve=>{
   const url=new URL(process.env.MEDIAMTX_RTSP_INTERNAL_URL||'rtsp://mediamtx:8554');
   url.username=process.env.MEDIAMTX_API_USER;url.password=process.env.MEDIAMTX_API_PASS;url.pathname='/'+path.name;
   const child=spawnWithSecretUrl('ffmpeg',['-hide_banner','-loglevel','error','-rtsp_transport','tcp','-i',url.toString(),'-t','20','-map','0:v:0','-c','copy','-f','framecrc','pipe:1'],url.toString(),{stdio:['ignore','pipe','pipe']});
   let pending='',last=null,frames=0,gaps=[],began=Date.now(),timebase=null,prevPts=null,ptsGaps=[];
   child.stderr.on('data',()=>{}); // FFmpeg errors can include its secret URL.
   child.stdout.on('data',chunk=>{
     pending+=chunk.toString();const lines=pending.split('\n');pending=lines.pop();
     for(const line of lines){
       const base=line.match(/^#tb 0: (\d+)\/(\d+)/);if(base)timebase=Number(base[1])/Number(base[2]);
       if(!/^0,/.test(line))continue;
       const now=Date.now(),pts=Number(line.split(',')[2]);
       if(last!==null&&now-last>200)gaps.push({at_ms:now-began,gap_ms:now-last});
       if(timebase&&prevPts!==null&&(pts-prevPts)*timebase>.2)ptsGaps.push((pts-prevPts)*timebase);
       last=now;prevPts=pts;frames++;
     }
   });
   const timeout=setTimeout(()=>child.kill('SIGTERM'),35000);
   child.on('error',()=>{clearTimeout(timeout);resolve();});
   child.on('close',code=>{clearTimeout(timeout);console.log(JSON.stringify({kind:path===grid?'grid':'original',code,frames,wall_ms:Date.now()-began,arrival_gaps_over_200ms:gaps.slice(0,40),presentation_gaps_over_200ms:ptsGaps.slice(0,40)}));resolve();});
 })));
})().catch(e=>{console.error(e.message);process.exitCode=1});
