// Runs in an isolated candidate container before replacing an existing API.
// All credentials come from inherited protected runtime configuration.
import { PrismaClient } from '@prisma/client';
import {deviceProof,deviceIdentity,trustedLicenseKeys,verifyLicense} from './signed-license';

async function main() {
  const installationId=process.env.CLOUD_INSTALLATION_ID || '';
  const apiUrl=process.env.CLOUD_API_URL || '';
  const key=process.env.CLOUD_LICENSE_KEY || '';
  const parsed=new URL(apiUrl);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||!installationId||!key)throw new Error('migration_configuration_invalid');
  const prisma=new PrismaClient();
  try {
    const proof=deviceProof(installationId);
    const rows=await prisma.systemSetting.findMany({where:{key:{in:['cloud.licenseGeneration','cloud.licenseSequence']}}});
    const settings=Object.fromEntries(rows.map(x=>[x.key,x.value]));
    const response=await fetch(apiUrl.replace(/\/$/,'')+'/api/agent/security/license',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{'Content-Type':'application/json','X-DRAC-Installation-Id':installationId,'X-DRAC-License-Key':key},
      body:JSON.stringify({licenseProof:proof}),
    });
    if(!response.ok)throw new Error('migration_license_request_refused');
    const data=await response.json() as {signedLicense?:string};
    const document=verifyLicense(data.signedLicense,{keys:trustedLicenseKeys(),installationId,
      device:deviceIdentity().fingerprint,nonce:proof.nonce,
      previous:{generation:Number(settings['cloud.licenseGeneration']||0),sequence:Number(settings['cloud.licenseSequence']||0)}});
    if(document.status==='SUSPENDED')throw new Error('migration_installation_suspended');
    const values={'cloud.signedLicense':data.signedLicense!,'cloud.licenseVerificationRequired':'true',
      'cloud.licenseGeneration':String(document.generation),'cloud.licenseSequence':String(document.sequence),
      'cloud.lastSyncAt':new Date(document.iat*1000).toISOString()};
    await prisma.$transaction(Object.entries(values).map(([key,value])=>prisma.systemSetting.upsert({where:{key},create:{key,value},update:{value}})));
    console.log(JSON.stringify({prepared:true,installationId,signatureVerified:true,securityProfile:'standard',generation:document.generation}));
  } finally {await prisma.$disconnect();}
}
void main().catch(()=>{console.error('Migration refused: existing installation was not replaced.');process.exitCode=1;});
