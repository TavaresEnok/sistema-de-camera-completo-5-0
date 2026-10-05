import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deviceIdentity,deviceProof,verifyLicense} from '../src/common/licensing/signed-license';
import {CommercialPolicyService} from '../src/commercial-policy/commercial-policy.service';
const {LicenseAuthority}=require('../../central/src/license-authority');

test('signed licenses: adversarial matrix and authoritative runtime policy',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'drac-signed-api-'));
  const names=['CLOUD_DEVICE_KEY_FILE','CLOUD_LICENSE_KEYS_FILE','CLOUD_LICENSE_VERIFICATION','CLOUD_INSTALLATION_ID'];
  const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of names){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}rmSync(dir,{recursive:true,force:true});});
  const key=generateKeyPairSync('ed25519');const device=generateKeyPairSync('ed25519');
  const signerFile=join(dir,'signer.pem');const deviceFile=join(dir,'device.pem');const trustFile=join(dir,'trust.json');
  writeFileSync(signerFile,key.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  writeFileSync(deviceFile,device.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  process.env.CLOUD_DEVICE_KEY_FILE=deviceFile;process.env.CLOUD_LICENSE_KEYS_FILE=trustFile;
  process.env.CLOUD_LICENSE_VERIFICATION='required';process.env.CLOUD_INSTALLATION_ID='signed-test';
  const authority=new LicenseAuthority({privateKeyFile:signerFile});const keys=authority.publicKeys();
  writeFileSync(trustFile,JSON.stringify(keys));
  const item={id:'signed-test'};const now=Date.now();
  const policy={licenseStatus:'ACTIVE',maxCameras:4,maxUsers:3,maxRetentionDays:7,restrictions:{aiMotion:false,aiObject:true,aiObjectClasses:['person','car','motorcycle','bicycle']}};
  const proof=deviceProof(item.id,now);const token=authority.issue(item,policy,proof,now);
  const options={keys,installationId:item.id,device:deviceIdentity().fingerprint,now,nonce:proof.nonce};
  const valid=verifyLicense(token,options);
  assert.equal(valid.limits.cameras,4);assert.equal(valid.restrictions.aiMotion,false);
  const reject=(value:unknown,extra={})=>assert.throws(()=>verifyLicense(value,{...options,...extra}));
  reject(token.replace(/.$/,token.endsWith('A')?'B':'A'));reject(token,{installationId:'cloned'});
  reject(token,{device:'a'.repeat(64)});reject(token,{nonce:'b'.repeat(64)});
  reject(token,{keys:{}});reject(token,{now:now+15*86400*1000});reject(token,{now:now-121000});
  reject(token,{previous:{generation:1,sequence:2}});reject(token,{previous:{generation:2,sequence:1}});
  const parts=token.split('.');const forged=JSON.parse(Buffer.from(parts[1],'base64url').toString());forged.limits.cameras=999;
  reject(parts[0]+'.'+Buffer.from(JSON.stringify(forged)).toString('base64url')+'.'+parts[2]);
  const none=Buffer.from(JSON.stringify({alg:'none',typ:'drac-license+jwt',kid:authority.keyId})).toString('base64url');reject(none+'.'+parts[1]+'.'+parts[2]);
  const changed=(changes:object)=>{
    const body=Buffer.from(JSON.stringify({...valid,...changes})).toString('base64url');
    const input=parts[0]+'.'+body;return input+'.'+sign(null,Buffer.from(input),key.privateKey).toString('base64url');
  };
  reject(changed({protection:'hardware'}));reject(changed({minSecurityVersion:2}));
  reject(changed({limits:{cameras:-1,users:null,retentionDays:null}}));reject(changed({objectClasses:['dog']}));
  reject(changed({exp:valid.iat+16*86400}));reject(changed({restrictions:{}}));
  const settings:Record<string,string>={'cloud.signedLicense':token,'cloud.licenseVerificationRequired':'true',
    'cloud.lastSyncAt':new Date(now).toISOString(),'cloud.licenseStatus':'ACTIVE',
    'cloud.maxCameras':'999','cloud.maxUsers':'999','cloud.maxRetentionDays':'999',
    'cloud.restrictions':JSON.stringify({aiMotion:true,aiObjectClasses:['dog']})};
  const service=new CommercialPolicyService({systemSetting:{findMany:async()=>Object.entries(settings).map(([key,value])=>({key,value}))}} as any);
  let runtime=await service.getPolicy();assert.equal(runtime.maxCameras,4);assert.equal(runtime.maxUsers,3);
  assert.equal(runtime.restrictions.aiMotion,false);assert.deepEqual(runtime.aiObjectClasses,['person','car','motorcycle','bicycle']);
  settings['cloud.maiorInstanteVisto']=new Date(now+10*86400*1000).toISOString();
  runtime=await service.getPolicy();assert.equal(runtime.licenseStatus,'RESTRICTED');assert.equal(runtime.restrictions.aiMotion,false);
  assert.equal(runtime.restrictions.localRecording,true);assert.equal(runtime.restrictions.aiAdvanced,false);
  settings['cloud.maiorInstanteVisto']=new Date(now+15*86400*1000).toISOString();
  runtime=await service.getPolicy();assert.equal(runtime.licenseStatus,'SUSPENDED');assert.equal(runtime.restrictions.localRecording,false);
  assert.equal(runtime.restrictions.localPlayback,true);assert.equal(runtime.restrictions.exports,true);assert.equal(runtime.restrictions.adminAccess,true);
  delete settings['cloud.signedLicense'];delete settings['cloud.maiorInstanteVisto'];delete process.env.CLOUD_LICENSE_VERIFICATION;
  runtime=await service.getPolicy();assert.equal(runtime.licenseStatus,'SUSPENDED');assert.equal(runtime.licenseVerification,'invalid');
  delete settings['cloud.licenseVerificationRequired'];
  runtime=await service.getPolicy();assert.equal(runtime.licenseStatus,'SUSPENDED');
  // Honest-process downgrade is refused; a hostile root rebuilding/replacing
  // this process is outside the protection of a standard VM.
});
