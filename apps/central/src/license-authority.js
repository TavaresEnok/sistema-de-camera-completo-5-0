'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const DAY = 86400;
const STATUSES = new Set(['ACTIVE', 'GRACE', 'RESTRICTED', 'SUSPENDED']);
const FEATURES = ['localLive','localRecording','localPlayback','addCameras','aiAdvanced','aiMotion','aiObject','aiFace','exports','adminAccess','cloudSupport','updates'];
function fingerprint(key) {
  const publicKey = crypto.createPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('license_key_type_invalid');
  return crypto.createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
}
function normalizeDeviceKey(pem) {
  if (typeof pem !== 'string' || pem.length > 4096 || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('device_key_invalid');
  const key=crypto.createPublicKey(pem);
  if(key.asymmetricKeyType!=='ed25519')throw new Error('device_key_type_invalid');
  return {pem:key.export({type:'spki',format:'pem'}).toString(),fingerprint:fingerprint(pem)};
}
function verifyDeviceRequest(request, installationId, now = Date.now()) {
  if (!request || request.v!==1 || request.installationId!==installationId || !Number.isSafeInteger(request.at)) throw new Error('device_proof_invalid');
  if(Math.abs(now-request.at)>120000 || !/^[a-f0-9]{64}$/.test(request.nonce||''))throw new Error('device_proof_expired');
  const key=normalizeDeviceKey(request.publicKey);
  const message=JSON.stringify([1,installationId,request.at,request.nonce,key.fingerprint]);
  if(typeof request.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(request.signature)||!crypto.verify(null,Buffer.from(message),key.pem,Buffer.from(request.signature,'base64url')))throw new Error('device_proof_signature_invalid');
  return {...key,nonce:request.nonce,at:request.at};
}
class LicenseAuthority {
  constructor({privateKeyFile, keyId}={}) {
    this.enabled=Boolean(privateKeyFile);
    if(!this.enabled)return;
    const stats=fs.statSync(privateKeyFile);
    if(!stats.isFile()||(stats.mode&0o077)!==0)throw new Error('license_signing_key_permissions_invalid');
    this.key=crypto.createPrivateKey(fs.readFileSync(privateKeyFile));
    if(this.key.asymmetricKeyType!=='ed25519')throw new Error('license_signing_key_type_invalid');
    this.publicKey=crypto.createPublicKey(this.key).export({type:'spki',format:'pem'}).toString();
    this.keyId=keyId||fingerprint(this.publicKey);
    if(!/^[a-f0-9]{64}$/.test(this.keyId)||this.keyId!==fingerprint(this.publicKey))throw new Error('license_signing_key_id_invalid');
  }
  publicKeys(){return this.enabled?{[this.keyId]:this.publicKey}:{};}
  issue(item, policy, request, now=Date.now()) {
    if(!this.enabled)throw new Error('license_signer_unavailable');
    const device=verifyDeviceRequest(request,item.id,now);
    if(item.licenseDevice?.fingerprint&&item.licenseDevice.fingerprint!==device.fingerprint)throw new Error('license_device_rebind_required');
    // The caller serializes this operation with the datastore. A second request
    // must not consume the same proof even after a Central restart.
    const used=(item.licenseProofNonces||[]).filter(x=>Number.isSafeInteger(x.at)&&now-x.at<=240000);
    if(used.some(x=>x.nonce===device.nonce))throw new Error('license_proof_replayed');
    // Never evict still-valid proofs: otherwise flooding could make a replay
    // valid again. Normal heartbeat cadence consumes at most 16 per window.
    if(used.length>=64)throw new Error('license_proof_rate_limited');
    const generation=Number.isSafeInteger(item.licenseGeneration)&&item.licenseGeneration>0?item.licenseGeneration:1;
    const previous=Number.isSafeInteger(item.licenseSequence)&&item.licenseSequence>=0?item.licenseSequence:0;
    if(previous>=Number.MAX_SAFE_INTEGER-1)throw new Error('license_sequence_exhausted');
    const iat=Math.floor(now/1000);
    const restrictions=Object.fromEntries(FEATURES.map(k=>[k,policy.restrictions?.[k]!==false]));
    const classes=['person','car','motorcycle','bicycle'].filter(k=>(policy.restrictions?.aiObjectClasses||[]).includes(k));
    const limit=n=>n==null?null:Number.isSafeInteger(n)&&n>=0?n:(()=>{throw new Error('license_limit_invalid')})();
    const payload={v:1,iss:'drac-central',aud:'drac-local',sub:item.id,device:device.fingerprint,
      generation,sequence:previous+1,nonce:device.nonce,iat,nbf:iat-120,
      restrictAt:iat+10*DAY,exp:iat+15*DAY,
      status:STATUSES.has(policy.licenseStatus)?policy.licenseStatus:'SUSPENDED',
      restrictions,objectClasses:classes,
      limits:{cameras:limit(policy.maxCameras),users:limit(policy.maxUsers),retentionDays:limit(policy.maxRetentionDays)},
      protection:'standard',minSecurityVersion:1};
    const header=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'drac-license+jwt',kid:this.keyId})).toString('base64url');
    const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
    const content=header+'.'+body;
    const signature=crypto.sign(null,Buffer.from(content),this.key).toString('base64url');
    item.licenseGeneration=generation;item.licenseSequence=previous+1;
    item.licenseDevice={fingerprint:device.fingerprint,publicKey:device.pem,boundAt:item.licenseDevice?.boundAt||new Date(now).toISOString()};
    item.licenseProofNonces=[...used,{nonce:device.nonce,at:device.at}];
    item.licenseLastIssuedAt=new Date(now).toISOString();
    return content+'.'+signature;
  }
}
module.exports={LicenseAuthority,fingerprint,normalizeDeviceKey,verifyDeviceRequest};
