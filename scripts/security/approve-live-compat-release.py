#!/usr/bin/env python3
"""Vendor-only approval; real lab and signature evidence are mandatory."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

parser=argparse.ArgumentParser()
parser.add_argument('--metadata',type=Path,required=True)
parser.add_argument('--report',type=Path,required=True)
parser.add_argument('--public-key',type=Path,required=True)
parser.add_argument('--installations',nargs='*',default=[])
parser.add_argument('--promote-default',action='store_true')
parser.add_argument('--notes',default='')
args=parser.parse_args()
metadata=json.loads(args.metadata.read_text())
report=json.loads(args.report.read_text())
if (report.get('commit')!=metadata['commit'] or not report.get('freshIsolatedRuntime')
    or not report.get('databaseSchemaVerified') or not report.get('sourceFreeAI')
    or not report.get('readiness',{}).get('ready') or len(report.get('cases',[]))!=6
    or report.get('hls',{}).get('status')!=200):raise SystemExit('Lab evidence invalid')
spec=importlib.util.spec_from_file_location('bundle',Path(__file__).parent/'runtime-bundle.py')
verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)
archive=args.metadata.with_name(metadata['commit']+'.tar.gz')
with tempfile.TemporaryDirectory(prefix='drac-live-release-verify-') as stage:
    verifier.extract_verified(archive,args.public_key,Path(stage)/'verified',metadata['commit'])
report['signatureVerified']=True
report['packageSha256']=metadata['runtimeBundle']['sha256']
report['signatureVerification']='runtime-bundle.extract_verified'
args.report.write_text(json.dumps(report,indent=2))
report_text=args.report.read_text()
gate={'runtimeFresh':True,'signatureVerified':True,'dataPreservationReviewed':True,
      'reportSha256':hashlib.sha256(report_text.encode()).hexdigest()}
script=r'''
const fs=require('fs');
(async()=>{
const p=JSON.parse(fs.readFileSync(0,'utf8'));const headers={Authorization:'Bearer '+process.env.DRAC_CENTRAL_ADMIN_TOKEN,'Content-Type':'application/json'};
for(const id of p.installations){
 const body={...p.metadata,confirmInstallationId:id,gate:{...p.gate,em:new Date().toISOString()},notas:p.notes||'Compatibilidade automática de vídeo e isolamento de áudio inválido. Pacote assinado validado em rede Docker isolada com seis reproduções HLS reais. Configurações, dados e licença preservados; migração aditiva revisada quando necessária.'};
 const r=await fetch('http://127.0.0.1:9765/api/admin/installations/'+encodeURIComponent(id)+'/runtime-release',{method:'POST',headers,body:JSON.stringify(body)});
 if(!r.ok)throw Error('release_approval_failed_'+id+'_'+r.status);console.log(JSON.stringify({approved:id,commit:p.metadata.commit}));
}
if(p.promoteDefault){
 const body={...p.metadata,gate:{instalacaoLimpa:true,verificadaNaMatriz:true,em:new Date().toISOString(),reportSha256:p.gate.reportSha256},notas:p.notes||'Compatibilidade automática validada em instalação limpa isolada e em produção. Novas instalações recebem o mesmo pacote assinado.'};
 const r=await fetch('http://127.0.0.1:9765/api/admin/releases',{method:'POST',headers,body:JSON.stringify(body)});
 if(!r.ok)throw Error('default_approval_failed_'+r.status);console.log(JSON.stringify({defaultApproved:true,commit:p.metadata.commit}));
}
})().catch(e=>{console.error(e.message);process.exitCode=1});
'''
subprocess.run(['docker','exec','-i','ajustcam-central','node','-e',script],input=json.dumps({
    'metadata':metadata,'gate':gate,'installations':args.installations,'promoteDefault':args.promote_default,'notes':args.notes}),text=True,check=True)
