"""Exercise bootstrap and update transactions without touching production Docker.

Signed fixture downloads and the real package verifier are used. Docker and
HTTPS transport are replaced explicitly; this is not a fresh-VM installation.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

DIRECTORY=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('bundle_lifecycle',DIRECTORY/'runtime-bundle.py')
bundle_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(bundle_module)
spec=importlib.util.spec_from_file_location('update_lifecycle',DIRECTORY/'update-runtime.py')
updater=importlib.util.module_from_spec(spec);spec.loader.exec_module(updater)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='drac-lifecycle-test-');self.root=Path(self.temp.name)
        self.key=self.root/'test-key.pem';self.public=self.root/'test-public.pem';self.commit='b'*40
        subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(self.key)],check=True,capture_output=True)
        subprocess.run(['openssl','pkey','-in',str(self.key),'-pubout','-out',str(self.public)],check=True,capture_output=True)
        self.real_run=subprocess.run;self.calls=[]
        self.payload={'images.tar':b'synthetic image payload; never imported into Docker',
                      'runtime/scripts/install-drac.sh':b'#!/bin/bash\nexit 0\n',
                      'runtime/infra/docker-compose.yml':b'services: {}\n'}
        self.archive,self.manifest=self.make_archive()
        self.grant={'commit':self.commit,'size':len(self.archive),'sha256':hashlib.sha256(self.archive).hexdigest(),'token':'x'*43}

    def tearDown(self):self.temp.cleanup()

    def make_archive(self):
        now=int(time.time())
        manifest={'v':1,'commit':self.commit,'securityVersion':1,'protection':'standard','issuedAt':now,'expiresAt':now+86400,
                  'databaseSchemaHash':'c'*64,'images':{k:'sha256:'+'d'*64 for k in ['api','web','ai-service']},
                  'files':{k:{'size':len(v),'sha256':hashlib.sha256(v).hexdigest()} for k,v in self.payload.items()}}
        raw=json.dumps(manifest,sort_keys=True,separators=(',',':')).encode();message=self.root/'signed-message'
        message.write_bytes(bundle_module.DOMAIN+raw)
        signature=subprocess.run(['openssl','pkeyutl','-sign','-inkey',str(self.key),'-rawin','-in',str(message)],check=True,capture_output=True).stdout
        output=io.BytesIO()
        with tarfile.open(fileobj=output,mode='w:gz') as archive:
            for name,value in {'manifest.json':raw,'manifest.sig':signature,**self.payload}.items():
                entry=tarfile.TarInfo(name);entry.size=len(value);archive.addfile(entry,io.BytesIO(value))
        return output.getvalue(),manifest

    def opener(self):
        owner=self
        class Transport:
            def open(self,request,timeout):
                url=request.full_url
                owner.assertEqual(request.get_header('X-drac-installation-id'),'fixture-client')
                if url.endswith('/api/agent/status'):
                    return io.BytesIO(json.dumps({'release':{'commit':owner.commit,'runtimeBundle':owner.grant}}).encode())
                if url.endswith('/api/agent/artifacts/claim'):return io.BytesIO(json.dumps(owner.grant).encode())
                if url.endswith('/api/agent/artifacts/download'):
                    owner.assertEqual(request.get_header('X-drac-artifact-grant'),'x'*43)
                    return io.BytesIO(owner.archive)
                raise AssertionError('Unexpected transport request')
        return Transport()

    def bootstrap(self):
        source=(DIRECTORY/'bootstrap-runtime.py').read_text()
        environment={'DRAC_CENTRAL_URL':'https://central.example.test','DRAC_INSTALLATION_ID':'fixture-client',
                     'DRAC_LICENSE_KEY':'fixture-not-a-production-secret','DRAC_INSTALLER_COMMIT':self.commit}
        def execute(command,**kwargs):
            if command[0]=='openssl':return self.real_run(command,**kwargs)
            self.assertEqual(command[0],'bash');self.calls.append(command)
            verified=Path(kwargs['env']['DRAC_VERIFIED_RUNTIME_DIR'])
            self.assertTrue((verified/'verified-manifest.json').is_file())
            self.assertEqual((verified/'runtime/infra/release-public.pem').read_text(),self.public.read_text())
            return subprocess.CompletedProcess(command,0)
        scope={**bundle_module.__dict__,'PUBLIC_RELEASE_KEY':self.public.read_text()}
        with patch.dict(os.environ,environment),patch('urllib.request.build_opener',return_value=self.opener()),patch('subprocess.run',side_effect=execute):
            exec(compile(source,str(DIRECTORY/'bootstrap-runtime.py'),'exec'),scope)

    def test_bootstrap_checks_signature_before_installer(self):
        self.bootstrap();self.assertEqual(len(self.calls),1)

    def test_bootstrap_corrupt_download_never_executes(self):
        self.archive+=b'corruption'
        with self.assertRaises(SystemExit):self.bootstrap()
        self.assertEqual(self.calls,[])

    def installation(self):
        root=self.root/'installation';(root/'infra').mkdir(parents=True);(root/'scripts/security').mkdir(parents=True)
        (root/'infra/.env').write_text('CLOUD_API_URL=https://central.example.test\nCLOUD_INSTALLATION_ID=fixture-client\nCLOUD_LICENSE_KEY=fixture-not-a-production-secret\n')
        state={**self.manifest,'commit':'a'*40};(root/'.runtime-release.json').write_text(json.dumps(state))
        shutil.copyfile(self.public,root/'infra/release-public.pem')
        shutil.copyfile(DIRECTORY/'runtime-bundle.py',root/'scripts/security/runtime-bundle.py')
        (root/'infra/docker-compose.yml').write_text('services: {}\n')
        (root/'infra/docker-compose.license-security.yml').write_text('services: {}\n')
        (root/'infra/license-state-preserved').write_text('existing device and license remain')
        return root

    def update(self,fail=False,schema_change=False):
        root=self.installation();old=(root/'.runtime-release.json').read_bytes()
        if schema_change:
            state=json.loads(old);state['databaseSchemaHash']='e'*64;(root/'.runtime-release.json').write_text(json.dumps(state))
        def execute(command,**kwargs):
            if command[0]=='openssl':return self.real_run(command,**kwargs)
            self.assertEqual(command[0],'docker');self.calls.append(command)
            if command[1:3]==['inspect','vms-api'] and len(command)==3:
                files=','.join(str(root/'infra'/f) for f in ['docker-compose.yml','docker-compose.license-security.yml'])
                return subprocess.CompletedProcess(command,0,json.dumps([{'Config':{'Labels':{'com.docker.compose.project.config_files':files}}}]))
            if command[1]=='inspect':return subprocess.CompletedProcess(command,0,'sha256:'+'f'*64)
            if 'pg_dump' in ' '.join(command):kwargs['stdout'].write(b'fixture verified backup')
            if 'compose' in command and 'up' in command and fail:
                fail_calls=sum('compose' in c and 'up' in c for c in self.calls)
                if fail_calls==1:raise subprocess.CalledProcessError(1,command)
            return subprocess.CompletedProcess(command,0,'')
        with patch('urllib.request.build_opener',return_value=self.opener()),patch('subprocess.run',side_effect=execute),contextlib.redirect_stdout(io.StringIO()):
            if fail or schema_change:
                with self.assertRaises(ValueError):updater.run(argparse.Namespace(root=root,commit=self.commit,conferir=False))
            else:updater.run(argparse.Namespace(root=root,commit=self.commit,conferir=False))
        self.assertEqual((root/'infra/license-state-preserved').read_text(),'existing device and license remain')
        compose=[c for c in self.calls if 'compose' in c and 'up' in c]
        if schema_change:self.assertEqual(self.calls,[]);return
        self.assertEqual(len(compose),2 if fail else 1)
        for command in compose:
            self.assertIn(str(root/'infra/docker-compose.license-security.yml'),command)
            self.assertIn(str(root/'infra/docker-compose.runtime-images.json'),command)
            self.assertIn('--no-deps',command);self.assertNotIn('mediamtx',command)
        saved=json.loads((root/'.runtime-release.json').read_text())
        self.assertEqual(saved['commit'],'a'*40 if fail else self.commit)
        if fail:
            images=json.loads((root/'infra/docker-compose.runtime-images.json').read_text())
            self.assertTrue(all(v['image']=='sha256:'+'f'*64 for v in images['services'].values()))

    def test_update_preserves_overlays_and_does_not_recreate_video_ingress(self):self.update()
    def test_failed_update_restores_images_not_license_database(self):self.update(fail=True)
    def test_schema_change_refused_before_docker_or_backup(self):self.update(schema_change=True)


if __name__=='__main__':unittest.main()
