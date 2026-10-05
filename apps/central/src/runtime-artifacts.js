'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const TTL=10*60*1000;
function bundleMetadata(value) {
  if(!value || !/^[a-f0-9]{64}$/.test(value.sha256||'') || !Number.isSafeInteger(value.size) || value.size<1 || value.size>12*1024**3 || !Number.isSafeInteger(value.securityVersion) || value.securityVersion<1)throw new Error('runtime_bundle_invalid');
  return {sha256:value.sha256,size:value.size,securityVersion:value.securityVersion};
}
class RuntimeArtifacts {
  constructor(directory){this.directory=directory?path.resolve(directory):null;}
  resolve(release) {
    if(!this.directory)throw new Error('runtime_artifacts_unavailable');
    if(!/^[a-f0-9]{40}$/.test(release?.commit||''))throw new Error('runtime_release_unavailable');
    const metadata=bundleMetadata(release.runtimeBundle);
    const file=path.join(this.directory,release.commit+'.tar.gz');
    const info=fs.lstatSync(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size!==metadata.size)throw new Error('runtime_artifact_unavailable');
    return {file,commit:release.commit,...metadata};
  }
  claim(item,release,now=Date.now()){
    const bundle=this.resolve(release);
    const token=crypto.randomBytes(32).toString('base64url');
    item.runtimeArtifactGrant={digest:crypto.createHash('sha256').update(token).digest('hex'),expiresAt:now+TTL,commit:bundle.commit,...bundleMetadata(bundle)};
    return {token,expiresAt:now+TTL,commit:bundle.commit,...bundleMetadata(bundle)};
  }
  consume(item,token,now=Date.now()){
    const grant=item?.runtimeArtifactGrant;
    if(!grant||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!Number.isSafeInteger(grant.expiresAt)||now>=grant.expiresAt)throw new Error('runtime_grant_invalid');
    const digest=crypto.createHash('sha256').update(token).digest('hex');
    if(!/^[a-f0-9]{64}$/.test(grant.digest)||!crypto.timingSafeEqual(Buffer.from(grant.digest,'hex'),Buffer.from(digest,'hex')))throw new Error('runtime_grant_invalid');
    const bundle=this.resolve({commit:grant.commit,runtimeBundle:grant});
    delete item.runtimeArtifactGrant;
    return bundle;
  }
}
module.exports={RuntimeArtifacts,bundleMetadata};
