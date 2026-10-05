import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const STATUSES = new Set(['ACTIVE', 'GRACE', 'RESTRICTED', 'SUSPENDED']);
const FEATURES = ['localLive','localRecording','localPlayback','addCameras','aiAdvanced','aiMotion','aiObject','aiFace','exports','adminAccess','cloudSupport','updates'];
export type LicenseDocument = {
  v:1; iss:'drac-central'; aud:'drac-local'; sub:string; device:string; generation:number; sequence:number;
  nonce:string; iat:number; nbf:number; restrictAt:number; exp:number;
  status:'ACTIVE'|'GRACE'|'RESTRICTED'|'SUSPENDED'; restrictions:Record<string,boolean>;
  objectClasses:string[]; limits:{cameras:number|null;users:number|null;retentionDays:number|null};
  protection:'standard'; minSecurityVersion:number;
};
export function deviceIdentity(keyFile=process.env.CLOUD_DEVICE_KEY_FILE||'/run/drac-license/device.pem') {
  const info=statSync(keyFile);
  if(!info.isFile()||(info.mode&0o077)!==0)throw new Error('license_device_key_permissions_invalid');
  const key=createPrivateKey(readFileSync(keyFile));
  if(key.asymmetricKeyType!=='ed25519')throw new Error('license_device_key_type_invalid');
  const pub=createPublicKey(key);const publicKey=pub.export({type:'spki',format:'pem'}).toString();
  const fingerprint=createHash('sha256').update(pub.export({type:'spki',format:'der'})).digest('hex');
  return {key,publicKey,fingerprint};
}
export function deviceProof(installationId:string,at=Date.now()) {
  const identity=deviceIdentity();const nonce=randomBytes(32).toString('hex');
  const message=JSON.stringify([1,installationId,at,nonce,identity.fingerprint]);
  return {v:1,installationId,at,nonce,publicKey:identity.publicKey,signature:sign(null,Buffer.from(message),identity.key).toString('base64url')};
}
export function trustedLicenseKeys():Record<string,string> {
  const raw=readFileSync(process.env.CLOUD_LICENSE_KEYS_FILE||'/run/drac-license/trusted-keys.json','utf8');
  const keys=JSON.parse(raw);
  if(!keys||typeof keys!=='object'||Array.isArray(keys)||Object.keys(keys).length<1||Object.keys(keys).length>8)throw new Error('license_trust_store_invalid');
  for(const [kid,pem] of Object.entries(keys)){
    if(typeof pem!=='string'||pem.length>4096||!pem.startsWith('-----BEGIN PUBLIC KEY-----'))throw new Error('license_trust_store_invalid');
    const key=createPublicKey(pem);
    if(key.asymmetricKeyType!=='ed25519'||kid!==createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex'))throw new Error('license_trust_store_invalid');
  }
  return keys;
}
export function verifyLicense(token:unknown, options:{keys:Record<string,string>;installationId:string;device:string;now?:number;nonce?:string;previous?:{generation:number;sequence:number}}):LicenseDocument {
  if(typeof token!=='string'||token.length>16384)throw new Error('license_document_invalid');
  const parts=token.split('.');
  if(parts.length!==3||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))throw new Error('license_document_invalid');
  if(parts[2].length!==86||parts.some(p=>Buffer.from(p,'base64url').toString('base64url')!==p))throw new Error('license_document_invalid');
  const header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
  if (!header || typeof header !== 'object' || Array.isArray(header) || typeof header.kid !== 'string' || !Object.hasOwn(options.keys, header.kid)) throw new Error('license_issuer_invalid');
  const pem=options.keys[header.kid];
  if(header.alg!=='EdDSA'||header.typ!=='drac-license+jwt'||typeof pem!=='string')throw new Error('license_issuer_invalid');
  const publicKey=createPublicKey(pem);
  if(publicKey.asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from(parts[0]+'.'+parts[1]),publicKey,Buffer.from(parts[2],'base64url')))throw new Error('license_signature_invalid');
  const d=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
  if(!d||d.v!==1||d.iss!=='drac-central'||d.aud!=='drac-local'||d.sub!==options.installationId||d.device!==options.device||!STATUSES.has(d.status)||d.protection!=='standard'||d.minSecurityVersion!==1)throw new Error('license_claims_invalid');
  for(const k of ['generation','sequence','iat','nbf','restrictAt','exp'])if(!Number.isSafeInteger(d[k])||d[k]<0)throw new Error('license_times_invalid');
  if(d.generation<1||d.sequence<1||d.nbf>d.iat||d.restrictAt!==d.iat+10*86400||d.exp!==d.iat+15*86400||d.iat-d.nbf>120)throw new Error('license_times_invalid');
  const now=Math.floor((options.now??Date.now())/1000);
  if(now<d.nbf||now>=d.exp)throw new Error('license_expired_or_not_yet_valid');
  if(options.nonce&&d.nonce!==options.nonce)throw new Error('license_nonce_invalid');
  if(!/^[a-f0-9]{64}$/.test(d.nonce||''))throw new Error('license_nonce_invalid');
  if(options.previous&&(d.generation<options.previous.generation||(d.generation===options.previous.generation&&d.sequence<options.previous.sequence)))throw new Error('license_rollback_detected');
  if(!d.restrictions||typeof d.restrictions!=='object'||FEATURES.some(k=>typeof d.restrictions[k]!=='boolean'))throw new Error('license_features_invalid');
  if(!Array.isArray(d.objectClasses)||d.objectClasses.length>4||d.objectClasses.some((k:string)=>!['person','car','motorcycle','bicycle'].includes(k)))throw new Error('license_features_invalid');
  if(!d.limits||['cameras','users','retentionDays'].some(k=>d.limits[k]!==null&&(!Number.isSafeInteger(d.limits[k])||d.limits[k]<0)))throw new Error('license_limits_invalid');
  return d;
}
export function licenseVerificationRequired(storedToken?:string|null, alreadyRequired?:string|null) {
  return Boolean(storedToken)||alreadyRequired==='true'||process.env.CLOUD_LICENSE_VERIFICATION==='required';
}
