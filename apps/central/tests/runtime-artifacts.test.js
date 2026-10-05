'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {RuntimeArtifacts,bundleMetadata}=require('../src/runtime-artifacts');
test('private runtime downloads: single use, expiry, tamper and traversal',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'drac-artifacts-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const commit='a'.repeat(40);fs.writeFileSync(path.join(dir,commit+'.tar.gz'),'abc');
  const store=new RuntimeArtifacts(dir);const item={};const release={commit,runtimeBundle:{sha256:'b'.repeat(64),size:3,securityVersion:1}};
  const grant=store.claim(item,release,1000);assert.equal(grant.token.length,43);
  assert.equal(JSON.stringify(item).includes(grant.token),false);
  assert.throws(()=>store.consume(item,'x'.repeat(43),1001),/invalid/);
  assert.equal(store.consume(item,grant.token,1001).commit,commit);
  assert.throws(()=>store.consume(item,grant.token,1002),/invalid/);
  const expired=store.claim(item,release,1000);assert.throws(()=>store.consume(item,expired.token,1000+10*60*1000),/invalid/);
  assert.throws(()=>store.resolve({...release,commit:'../secret'}),/unavailable/);
  assert.throws(()=>bundleMetadata({sha256:'b'.repeat(64),size:3,securityVersion:0}),/invalid/);
  fs.unlinkSync(path.join(dir,commit+'.tar.gz'));fs.symlinkSync('/etc/passwd',path.join(dir,commit+'.tar.gz'));
  assert.throws(()=>store.resolve(release),/unavailable/);
});
