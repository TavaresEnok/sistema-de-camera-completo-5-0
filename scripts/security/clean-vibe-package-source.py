#!/usr/bin/env python3
"""One reviewed Vibe cleanup; never prune volumes or remove production containers.

Requires verified external recovery copies. This is not a general-purpose
recursive cleanup tool. Paths and image IDs are explicitly reviewed.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT=Path('/opt/drac')
VENDOR=Path('/opt/drac-security-20261005')
BACKUP=ROOT/'infra/backups/vibe-package-20261005'
REMOTE='/opt/ajustcam-management/backups/vibe-pre-package-20261005/'

def run(args,**kw):return subprocess.run(args,check=True,**kw)
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  while chunk:=stream.read(1024*1024):h.update(chunk)
 return h.hexdigest()

def main():
 state=json.loads((ROOT/'.runtime-release.json').read_text())
 if state['commit']!='66317dcf01e230a3e9bffa7fb6a69483c06c97e0':raise ValueError('Unexpected live runtime')
 obsolete=json.loads((VENDOR/'tools/vibe-obsolete-images-20261005.json').read_text())
 targets=[x['imageId'] for x in obsolete]
 containers=json.loads(run(['docker','inspect',*run(['docker','ps','-aq'],capture_output=True,text=True).stdout.split()],capture_output=True,text=True).stdout)
 allowed={'drac-operational-lab-api','drac-operational-browser','drac-operational-web-check','drac-operational-api-check',
          'drac-operational-lab-web','drac-mobile-audit-final','vms-central','drac-srs-pilot-forward','drac-srs-forward-build-3','drac-srs-forward-build-2'}
 removals=[]
 for c in containers:
  image=run(['docker','image','inspect',c['Image'],'--format','{{.Id}}'],capture_output=True,text=True).stdout.strip()
  if image in targets:
   name=c['Name'].lstrip('/')
   if name not in allowed or (name=='vms-central' and c['State']['Running']):raise ValueError('Unexpected container depends on obsolete image: '+name)
   removals.append(name)
 for name,remote_name in [('source-stable.before.tar.gz','source.before.tar.gz'),('application-images.before.tar.gz','application-images.before.tar.gz'),
                         ('development-copies.before.tar.gz','development-copies.before.tar.gz'),('obsolete-images.before.tar.gz','obsolete-images.before.tar.gz'),
                         ('vendor-source.before.tar.gz','vendor-source.before.tar.gz')]:
  expected=digest(BACKUP/name)
  actual=run(['ssh','-o','BatchMode=yes','-o','ControlPath=/tmp/drac-package-management-20261005','-p','22002','management@177.104.156.25',
              'sha256sum '+REMOTE+remote_name],capture_output=True,text=True).stdout.split()[0]
  if expected!=actual:raise ValueError('External recovery copy differs: '+name)
 # Every target is resolved and validated before the first removal.
 paths=[ROOT/x for x in ['.git','.github','apps','services','archive','legacy','docs','Drac-app-redesign','novo-design','novo-mockup-app-drac','redesig central']]
 paths += [Path(x) for x in ['/opt/drac-dguardian-20261002','/opt/drac-pipeline-20261001',
  '/tmp/drac-clean-source-20261004','/tmp/drac-ib-hotfix-20260929','/tmp/drac-ib-perimeter-deploy-hhenKC',
  '/tmp/drac-pipeline-20261001','/tmp/drac-recorded-release.xOtdJR','/tmp/drac-video-handoff.2pOd7i',
  '/tmp/drac-central-pilot-20261005.tar','/tmp/drac-central-pilot-final-20261005.tar','/tmp/drac-recorded-release-20261004.tar.gz']]
 paths += [ROOT/x for x in ['README.md','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.dockerignore','.gitignore']]
 paths.append(VENDOR)
 for path in paths:
  if path.is_symlink():raise ValueError('Unexpected symlink target: '+str(path))
 for name in removals:run(['docker','rm','-f',name],stdout=subprocess.DEVNULL)
 # Forced image untagging is necessary for old images with multiple tags.
 # All container references were checked above; production images excluded.
 for image in targets:run(['docker','image','rm','-f',image],stdout=subprocess.DEVNULL)
 run(['docker','builder','prune','--all','--force'],stdout=subprocess.DEVNULL)
 removed=[]
 for path in paths:
  if path.is_dir():shutil.rmtree(path);removed.append(str(path))
  elif path.is_file():path.unlink();removed.append(str(path))
 # Remove development-only scripts. Keep signed operational glue and existing
 # administration/diagnostic/restore helpers required for a local installation.
 for name in ['build-landing.mjs','build-motion-review.py','e2e-postgres-fixture.sh','e2e-rtsp-fixture.sh',
              'promover-release.sh','repo-hygiene.sh','run-build-agent-supervised.sh','test-ai-container.sh','teste-instalacao-limpa.sh']:
  path=ROOT/'scripts'/name
  if path.is_file():path.unlink();removed.append(str(path))
 tests=ROOT/'scripts/tests'
 if tests.is_dir():shutil.rmtree(tests);removed.append(str(tests))
 # The four local bundle copies are generated, source-free artifacts. Current
 # approved archive/metadata already exist on vendor Management, not customer.
 for value in ['/opt/drac-package-build-20261005','/opt/drac-package-build-final-20261005',
               '/opt/drac-package-build-fixed-20261005','/opt/drac-package-logo-final-20261005']:
  path=Path(value)
  if path.is_symlink():raise ValueError('Unexpected bundle path')
  if path.is_dir():shutil.rmtree(path);removed.append(value)
 # Sources and source-bearing image archives must not remain in local backups.
 for path in BACKUP.iterdir():
  if path.name.endswith('.tar.gz'):path.unlink();removed.append(str(path))
 report={'runtimeCommit':state['commit'],'externalBackupsVerified':True,'imagesRemoved':len(targets),'containersRemoved':removals,
         'pathsRemoved':removed,'volumesRemoved':False,'productionMediaRestarted':False}
 (BACKUP/'cleanup-report.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report))

if __name__=='__main__':main()
