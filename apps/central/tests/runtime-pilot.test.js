'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {startCentral}=require('./helpers/central-server');
const releases=require('../src/releases');

test('pilot release is scoped: unrelated installations stay on global release',()=>{
  const global={commit:'a'.repeat(40)};const pilot={commit:'b'.repeat(40),runtimeBundle:{sha256:'c'.repeat(64),size:3,securityVersion:1}};
  assert.equal(releases.releaseParaInstalacao(global,{version:global.commit}).commit,global.commit);
  assert.equal(releases.releaseParaInstalacao(global,{version:pilot.commit,runtimeRelease:pilot}).situacao,'atualizada');
  assert.equal(releases.situacaoDaInstalacao({version:pilot.commit,runtimeRelease:pilot},global),'atualizada');
  assert.equal(releases.resumoDaFrota([{version:pilot.commit,runtimeRelease:pilot}],global).atualizada,1);
});

test('runtime pilot HTTP approval requires confirmation, gate, authentication and available package',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'drac-pilot-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const commit='b'.repeat(40);fs.writeFileSync(path.join(dir,commit+'.tar.gz'),'abc');
  const central=await startCentral({DRAC_CENTRAL_RUNTIME_DIR:dir,DRAC_CENTRAL_PUBLIC_URL:'https://central.example.test'});t.after(()=>central.stop());
  const create=await fetch(central.base+'/api/admin/provision',{method:'POST',headers:central.adminHeaders(),body:JSON.stringify({installationId:'pilot',customerName:'Pilot',cameraAllowedCidrs:'192.168.1.0/24'})});
  assert.equal(create.status,201);
  const url=central.base+'/api/admin/installations/pilot/runtime-release';
  const body={confirmInstallationId:'pilot',commit,installerSha256:'c'.repeat(64),runtimeBundle:{sha256:'c'.repeat(64),size:3,securityVersion:1},gate:{runtimeFresh:true,signatureVerified:true,dataPreservationReviewed:true,reportSha256:'a'.repeat(64),em:new Date().toISOString()}};
  const post=(data,headers=central.adminHeaders())=>fetch(url,{method:'POST',headers,body:JSON.stringify(data)});
  assert.equal((await post(body,{'content-type':'application/json'})).status,401);
  assert.equal((await post({...body,confirmInstallationId:'other'})).status,400);
  assert.equal((await post({...body,gate:{}})).status,400);
  assert.equal((await post({...body,commit:'d'.repeat(40)})).status,409);
  const result=await post(body);assert.equal(result.status,200);assert.equal((await result.json()).release.commit,commit);
  const installer=await fetch(central.base+'/api/admin/installations/pilot/installer',{headers:central.adminHeaders()});
  assert.equal(installer.status,200);
  const issued=await installer.json();
  assert.equal(issued.installerArtifact.id,commit);
  assert.equal(issued.installerArtifact.compatibility,'signed-runtime');
  assert.match(issued.installerArtifact.url,/\/api\/security\/bootstrap\//);
});
