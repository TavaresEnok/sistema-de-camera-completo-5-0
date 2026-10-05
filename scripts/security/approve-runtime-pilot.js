'use strict';
// Execute inside vendor Central. Credentials stay in its existing environment.
const fs=require('node:fs');const crypto=require('node:crypto');
(async()=>{
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  const report=JSON.parse(input.reportText);
  if(!report.freshIsolatedRuntime||!report.realDockerServices||!report.signatureVerified||!report.sourceFreeAI
    ||!report.readiness?.ready||report.bootstrapLogin?.status!==201||report.hls?.status!==200
    ||report.commit!==input.metadata.commit||input.installationId!=='dguardian')throw new Error('pilot_evidence_invalid');
  const request={...input.metadata,confirmInstallationId:input.installationId,
    gate:{runtimeFresh:true,signatureVerified:true,dataPreservationReviewed:true,
      reportSha256:crypto.createHash('sha256').update(input.reportText).digest('hex'),em:new Date().toISOString()},
    notas:'First local runtime pilot: fresh isolated Docker + synthetic RTSP/capture/motion/recording/HLS; not physical customer-camera or ICE validation.'};
  const response=await fetch('http://127.0.0.1:9765/api/admin/installations/'+input.installationId+'/runtime-release',
    {method:'POST',headers:{authorization:'Bearer '+process.env.DRAC_CENTRAL_ADMIN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(request)});
  if(!response.ok)throw new Error('pilot_approval_failed_'+response.status);
  const result=await response.json();console.log(JSON.stringify({approved:true,installationId:input.installationId,commit:result.release.commit}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
