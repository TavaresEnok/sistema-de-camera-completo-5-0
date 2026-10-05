'use strict';
// Vendor Central only. Backups contain authenticated ciphertext, never an
// unprotected second private key. Store the master backup secret separately.
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
const {LicenseAuthority}=require('../src/license-authority');
const authority=new LicenseAuthority({privateKeyFile:process.env.DRAC_CENTRAL_LICENSE_SIGNING_KEY_FILE});
const secret=process.env.DRAC_CENTRAL_SECRET_KEY;
if(!authority.enabled||typeof secret!=='string'||secret.length<32)throw new Error('license_backup_configuration_invalid');
const directory=path.dirname(process.env.DRAC_CENTRAL_DATA_FILE||'/app/data/installations.json');
const target=path.join(directory,'license-issuer-'+authority.keyId+'.backup.enc');
const privateKey=Buffer.from(authority.key.export({type:'pkcs8',format:'pem'}));
const aad=Buffer.from('drac-license-issuer-backup-v1:'+authority.keyId);
if(fs.existsSync(target)){
  const envelope=JSON.parse(fs.readFileSync(target,'utf8'));
  const key=crypto.scryptSync(secret,Buffer.from(envelope.salt,'base64'),32);
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
  decipher.setAAD(aad);decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  const recovered=Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]);
  if(recovered.length!==privateKey.length||!crypto.timingSafeEqual(recovered,privateKey))throw new Error('license_backup_verification_failed');
}else{
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12);
  const key=crypto.scryptSync(secret,salt,32);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
  const data=Buffer.concat([cipher.update(privateKey),cipher.final()]);
  fs.writeFileSync(target,JSON.stringify({v:1,kid:authority.keyId,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}),{mode:0o600,flag:'wx'});
}
privateKey.fill(0);
console.log(JSON.stringify({encryptedBackupVerified:true,keyId:authority.keyId}));
