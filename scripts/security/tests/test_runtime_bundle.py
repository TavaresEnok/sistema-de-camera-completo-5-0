import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import unittest
import hashlib

SOURCE=Path(__file__).resolve().parents[1]/'runtime-bundle.py'
spec=importlib.util.spec_from_file_location('runtime_bundle',SOURCE)
loader=importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)

class RuntimeBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='drac-runtime-test-')
        self.root=Path(self.temp.name)
        self.key=self.root/'fixture-key.pem';self.pub=self.root/'fixture-public.pem'
        subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(self.key)],check=True,capture_output=True)
        subprocess.run(['openssl','pkey','-in',str(self.key),'-pubout','-out',str(self.pub)],check=True,capture_output=True)
        self.commit='a'*40
        self.payload={'images.tar':b'fixture-image-not-executed','runtime/infra/docker-compose.yml':b'services: {}'}

    def tearDown(self): self.temp.cleanup()

    def bundle(self,changes=None,extra=None,tamper=False):
        now=int(time.time())
        manifest={'v':1,'commit':self.commit,'securityVersion':1,'protection':'standard','issuedAt':now,'expiresAt':now+86400,
            'files':{k:{'size':len(v),'sha256':hashlib.sha256(v).hexdigest()} for k,v in self.payload.items()}}
        manifest.update(changes or {})
        raw=json.dumps(manifest,separators=(',',':'),sort_keys=True).encode()
        message=self.root/'message';message.write_bytes(loader.DOMAIN+raw)
        signature=subprocess.run(['openssl','pkeyutl','-sign','-inkey',str(self.key),'-rawin','-in',str(message)],check=True,capture_output=True).stdout
        if tamper:signature=b'0'*64
        values={'manifest.json':raw,'manifest.sig':signature,**self.payload,**(extra or {})}
        bundle=self.root/'bundle.tar.gz'
        with tarfile.open(bundle,'w:gz') as archive:
            for name,value in values.items():
                entry=tarfile.TarInfo(name);entry.size=len(value);archive.addfile(entry,io.BytesIO(value))
        return bundle

    def check(self,bundle):return loader.extract_verified(bundle,self.pub,self.root/'output',self.commit)

    def test_valid_signed_package(self):
        result=self.check(self.bundle());self.assertEqual(result['commit'],self.commit)
        self.assertEqual((self.root/'output/images.tar').read_bytes(),self.payload['images.tar'])

    def test_tampered_signature_writes_no_payload(self):
        with self.assertRaises(ValueError):self.check(self.bundle(tamper=True))
        self.assertFalse((self.root/'output/images.tar').exists())

    def test_extra_file_and_path_traversal_refused(self):
        for name in ['../escape','runtime/infra/.env','runtime/apps/central/server.js','runtime/scripts/unexpected.ts']:
            with self.subTest(name=name),self.assertRaises(ValueError):self.check(self.bundle(extra={name:b'bad'}))

    def test_expiry_downgrade_and_wrong_release(self):
        for changes in [{'expiresAt':int(time.time())-1},{'securityVersion':0},{'commit':'b'*40},{'protection':'hardware'}]:
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.check(self.bundle(changes=changes))

    def test_signed_wrong_checksum_still_refused(self):
        with self.assertRaises(ValueError):self.check(self.bundle(changes={'files':{k:{'size':len(v),'sha256':'0'*64} for k,v in self.payload.items()}}))

    def test_symlink_hardlink_duplicates_and_nonempty_destination(self):
        bundle=self.bundle()
        bad=self.root/'link.tar.gz'
        with tarfile.open(bundle,'r:gz') as source,tarfile.open(bad,'w:gz') as target:
            for entry in source:target.addfile(entry,source.extractfile(entry))
            entry=tarfile.TarInfo('runtime/scripts/link');entry.type=tarfile.SYMTYPE;entry.linkname='/etc/passwd';target.addfile(entry)
        with self.assertRaises(ValueError):self.check(bad)
        (self.root/'output').mkdir();(self.root/'output/existing').write_text('preserve')
        with self.assertRaises(ValueError):self.check(bundle)
        self.assertEqual((self.root/'output/existing').read_text(),'preserve')

if __name__=='__main__':unittest.main()
