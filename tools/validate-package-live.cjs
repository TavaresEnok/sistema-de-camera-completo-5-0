// Run inside the API container. Short-lived maintenance token stays in memory.
// Does not change accounts, passwords, camera modes or license configuration.
const {PrismaClient}=require('/app/apps/api/node_modules/@prisma/client');
const {JwtService}=require('/app/apps/api/node_modules/@nestjs/jwt');
const p=new PrismaClient();
(async()=>{
 const u=await p.user.findFirst({where:{role:'SUPER_ADMIN',isActive:true}});
 if(!u)throw Error('Active administrator missing');
 const token=await new JwtService({secret:process.env.JWT_SECRET}).signAsync({sub:u.id,username:u.username,email:u.email||u.username,role:u.role,ver:u.authVersion,type:'access'},{expiresIn:'180s'});
 const headers={Authorization:'Bearer '+token};
 const get=async path=>{const r=await fetch('http://127.0.0.1:3000'+path,{headers,signal:AbortSignal.timeout(25000)});return {status:r.status,body:await r.json()}};
 const cloud=await get('/cloud-connector/status'),cameras=await get('/cameras');
 const tests=[];
 for(const camera of await p.camera.findMany({where:{recordingMode:'motion',enabled:true},select:{id:true,name:true}})){
  const r=await get('/camera-stream/'+camera.id+'/urls?viewMode=grid');
  const protocols=r.body.protocols||{};
  const hls=protocols.hlsUrl;let hlsStatus=null,playlist=false;
  if(hls){const url=new URL(hls);url.searchParams.set('token',r.body.streamToken);const res=await fetch(url,{signal:AbortSignal.timeout(25000)});hlsStatus=res.status;playlist=(await res.text()).startsWith('#EXTM3U');}
  tests.push({camera:camera.name,deliveryStatus:r.status,pathReady:r.body.liveDiagnostics?.pathReady,hlsStatus,playlist});
 }
 console.log(JSON.stringify({cloudStatus:cloud.status,license:cloud.body.licenseStatus,lastError:cloud.body.lastError,camerasStatus:cameras.status,tests}));
 if(cloud.status!==200||cloud.body.licenseStatus!=='ACTIVE'||cameras.status!==200||tests.some(x=>x.deliveryStatus!==200||!x.pathReady||x.hlsStatus!==200||!x.playlist))process.exitCode=1;
})().catch(e=>{console.error(e.name);process.exitCode=1}).finally(()=>p.$disconnect());
