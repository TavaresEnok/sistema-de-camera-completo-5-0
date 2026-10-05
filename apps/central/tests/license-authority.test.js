'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {LicenseAuthority,fingerprint}=require('../src/license-authority');
const {startCentral}=require('./helpers/central-server');

function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'drac-license-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const signer=crypto.generateKeyPairSync('ed25519');
  const file=path.join(dir,'signer.pem');
  fs.writeFileSync(file,signer.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const authority=new LicenseAuthority({privateKeyFile:file});
  const device=crypto.generateKeyPairSync('ed25519');
  const publicKey=device.publicKey.export({type:'spki',format:'pem'}).toString();
  const item={id:'installation-test'};
  const policy={licenseStatus:'ACTIVE',maxCameras:4,maxUsers:3,maxRetentionDays:7,
    restrictions:{aiObject:false,aiFace:false,aiObjectClasses:['person','car','motorcycle','bicycle']}};
  const proof=(at=Date.now(),key=device)=>{
    const pem=key.publicKey.export({type:'spki',format:'pem'}).toString();
    const nonce=crypto.randomBytes(32).toString('hex');
    const message=JSON.stringify([1,item.id,at,nonce,fingerprint(pem)]);
    return {v:1,installationId:item.id,at,nonce,publicKey:pem,signature:crypto.sign(null,Buffer.from(message),key.privateKey).toString('base64url')};
  };
  return {file,authority,device,publicKey,item,policy,proof};
}
test('Central signs device-bound limits without exposing its private key',t=>{
  const s=setup(t);const p=s.proof();const token=s.authority.issue(s.item,s.policy,p);
  const [header,payload,sig]=token.split('.');const d=JSON.parse(Buffer.from(payload,'base64url'));
  assert.equal(crypto.verify(null,Buffer.from(header+'.'+payload),s.authority.publicKey,Buffer.from(sig,'base64url')),true);
  assert.equal(d.device,fingerprint(s.publicKey));assert.equal(d.sub,s.item.id);
  assert.deepEqual(d.limits,{cameras:4,users:3,retentionDays:7});
  assert.equal(d.restrictions.aiObject,false);assert.equal(d.exp-d.iat,15*86400);
  assert.equal(d.protection,'standard');assert.equal(d.sequence,1);
  assert.equal(JSON.stringify(d).includes('PRIVATE KEY'),false);
});
test('reject replay, flood eviction, stale and forged device proofs',t=>{
  const s=setup(t);const p=s.proof();s.authority.issue(s.item,s.policy,p);
  assert.throws(()=>s.authority.issue(s.item,s.policy,p),/replayed/);
  assert.throws(()=>s.authority.issue(s.item,s.policy,s.proof(Date.now()-121000)),/expired/);
  assert.throws(()=>s.authority.issue(s.item,s.policy,{...s.proof(),installationId:'wrong'}),/invalid/);
  const forged=s.proof();forged.nonce='f'.repeat(64);
  assert.throws(()=>s.authority.issue(s.item,s.policy,forged),/signature/);
  for(let i=1;i<64;i++)s.authority.issue(s.item,s.policy,s.proof());
  assert.throws(()=>s.authority.issue(s.item,s.policy,s.proof()),/rate_limited/);
  assert.throws(()=>s.authority.issue(s.item,s.policy,p),/replayed/);
});
test('copied installation ID/license bootstrap cannot bind a second device',t=>{
  const s=setup(t);s.authority.issue(s.item,s.policy,s.proof());
  assert.throws(()=>s.authority.issue(s.item,s.policy,s.proof(Date.now(),crypto.generateKeyPairSync('ed25519'))),/rebind_required/);
  const persisted=JSON.parse(JSON.stringify(s.item));
  const restarted=new LicenseAuthority({privateKeyFile:s.file});
  const token=restarted.issue(persisted,s.policy,s.proof());
  assert.equal(JSON.parse(Buffer.from(token.split('.')[1],'base64url')).sequence,2);
});
test('signer refuses group/world-readable keys',t=>{
  const s=setup(t);fs.chmodSync(s.file,0o644);
  assert.throws(()=>new LicenseAuthority({privateKeyFile:s.file}),/permissions_invalid/);
});
test('real HTTP heartbeat migration, bound-device downgrade denial and audited reset',async t=>{
  const s=setup(t);const central=await startCentral({DRAC_CENTRAL_LICENSE_SIGNING_KEY_FILE:s.file});
  t.after(()=>central.stop());
  const admin=async (url,body)=>{
    const r=await fetch(central.base+url,{method:'POST',headers:central.adminHeaders(),body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const provision=await admin('/api/admin/provision',{installationId:s.item.id,customerName:'License test'});
  assert.equal(provision.status,201,JSON.stringify(provision.body));
  const disk=JSON.parse(fs.readFileSync(path.join(central.dir,'installations.json'),'utf8'));
  const item=disk.installations[s.item.id];assert.ok(item);
  const headers={'content-type':'application/json','x-drac-installation-id':item.id,'x-drac-license-key':item.licenseKey};
  const beat=body=>fetch(central.base+'/api/agent/heartbeat',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await beat({})).status,200);
  const proof=s.proof();const signed=await beat({licenseProof:proof});assert.equal(signed.status,200);
  assert.ok((await signed.json()).signedLicense);
  assert.equal((await beat({})).status,403);assert.equal((await beat({licenseProof:proof})).status,403);
  const reset=await admin(`/api/admin/installations/${item.id}/security/device-reset`,{confirmInstallationId:item.id,reason:'Replacement test'});
  assert.equal(reset.status,200);assert.equal(reset.body.generation,2);
  const fresh=await beat({licenseProof:s.proof(Date.now(),crypto.generateKeyPairSync('ed25519'))});assert.equal(fresh.status,200);
  const d=JSON.parse(Buffer.from((await fresh.json()).signedLicense.split('.')[1],'base64url'));
  assert.equal(d.generation,2);assert.equal(d.sequence,1);
});
