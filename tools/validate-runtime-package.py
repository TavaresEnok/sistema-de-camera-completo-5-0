#!/usr/bin/env python3
"""Fresh source-free runtime lab with real Docker/services and synthetic video.

No production ports, databases, cameras or installation identities are used.
This exercises package extraction, fresh DB, bootstrap/login, native capture,
motion, RTSP, recording-copy, HLS and WHEP signaling, not physical client ICE.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
import yaml

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('verify_runtime',ROOT/'scripts/security/runtime-bundle.py')
verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)

def run(command,**kwargs):return subprocess.run(command,check=True,capture_output=True,text=True,**kwargs)

def validate(args):
    project='drac-package-lab-'+uuid.uuid4().hex[:8];publisher=None
    with tempfile.TemporaryDirectory(prefix='drac-runtime-lab-') as directory:
        stage=Path(directory);verified=stage/'verified'
        manifest=verifier.extract_verified(args.bundle,args.public_key,verified,args.commit)
        infra=verified/'runtime/infra'
        configuration=yaml.safe_load((infra/'docker-compose.yml').read_text())
        keep={'postgres','redis','api','web','ai-service','mediamtx'}
        configuration['services']={k:v for k,v in configuration['services'].items() if k in keep}
        for name,service in configuration['services'].items():
            service['container_name']=project+'-'+name;service.pop('ports',None)
            service['networks']=['vms-net'];service.pop('restart',None)
            service['cpus']=2
        configuration['networks']={'vms-net':{'driver':'bridge','internal':True}}
        environment={}
        for line in (infra/'.env.example').read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                name,value=line.split('=',1);environment[name]=value
        for name in environment:
            if any(word in name for word in ['PASS','SECRET','TOKEN','ENCRYPTION_KEY']):environment[name]=uuid.uuid4().hex+uuid.uuid4().hex
        environment.update({'CLOUD_CONNECTOR_ENABLED':'false','CLOUD_INSTALLATION_ID':'isolated-package-lab',
            'CLOUD_API_URL':'https://central.invalid','CLOUD_HEARTBEAT_INTERVAL_SECONDS':'3600','DRAC_VERSION':manifest['commit'],'MEDIAMTX_WEBRTC_ADDITIONAL_HOST':'mediamtx',
            'MOTION_DETECTION_FPS':'7.0','AI_ONVIF_SEMANTIC_FILTER':'false','MOTION_SEMANTIC_CONFIRM':'false',
            'MEDIAMTX_API_USER':'fixture-media','RECORDING_AUTO_START_ENABLED':'false'})
        (infra/'.env').write_text('\n'.join(k+'='+v for k,v in environment.items())+'\n');os.chmod(infra/'.env',0o600)
        for name in ['storage','backups/postgres','apk','ai-models','license']:(infra/name).mkdir(parents=True,exist_ok=True)
        # Match the installer, including when the vendor runs this lab as root.
        os.chown(infra/'storage',1000,1000)
        run(['openssl','genpkey','-algorithm','ED25519','-out',str(infra/'license/device.pem')]);os.chmod(infra/'license/device.pem',0o600)
        os.chown(infra/'license/device.pem',1000,1000)
        (infra/'license/trusted-keys.json').write_bytes((infra/'trusted-license-keys.json').read_bytes())
        api=configuration['services']['api'];api['environment']={x.split('=',1)[0]:x.split('=',1)[1] for x in api['environment']}
        api['environment'].update({'CLOUD_LICENSE_VERIFICATION':'required','CLOUD_DEVICE_KEY_FILE':'/run/drac-license/device.pem','CLOUD_LICENSE_KEYS_FILE':'/run/drac-license/trusted-keys.json'})
        api['volumes'].append('./license:/run/drac-license:ro')
        # Authentication disabled only on this isolated no-port lab media server.
        media={'api':True,'apiAddress':':9997','rtsp':True,'rtspAddress':':8554','hls':True,'hlsAddress':':8888',
            'hlsAlwaysRemux':True,'webrtc':True,'webrtcAddress':':8889','paths':{'all_others':{}},
            'authMethod':'internal','authInternalUsers':[{'user':'any','pass':'','ips':[],'permissions':[{'action':x} for x in ['publish','read','api','metrics']]}]}
        (infra/'mediamtx-lab.yml').write_text(yaml.safe_dump(media))
        configuration['services']['mediamtx']['volumes']=['./mediamtx-lab.yml:/mediamtx.yml:ro']
        configuration['services']['mediamtx']['environment']=[]
        file=infra/'lab-compose.yml';file.write_text(yaml.safe_dump(configuration,sort_keys=False))
        compose=['docker','compose','--project-name',project,'--env-file',str(infra/'.env'),'-f',str(file)]
        def node(source):return json.loads(run(['docker','exec','-i','-w','/app/apps/api',project+'-api','node','-'],input=source).stdout)
        try:
            run(['bash',str(verified/'runtime/scripts/install-ai-models.sh'),str(infra/'ai-models')])
            try:
                run(compose+['up','-d','--no-build','--pull','never','--wait','--wait-timeout','180'])
            except subprocess.CalledProcessError as error:
                def redact(message):
                    for key, value in environment.items():
                        if value and any(word in key for word in ['PASS','SECRET','TOKEN','KEY','DATABASE_URL']):
                            message=message.replace(value, '[REDACTED]')
                    return message
                print(redact(str(error.stderr)[-3000:]), flush=True)
                for service in ['api','ai-service','postgres','mediamtx']:
                    logs=subprocess.run(['docker','logs','--tail','15',project+'-'+service],capture_output=True,text=True)
                    print(service+': '+redact(logs.stdout+logs.stderr),flush=True)
                raise
            ready=node('fetch("http://127.0.0.1:3000/health/ready").then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))')
            if not ready.get('ready'):raise ValueError('Fresh package readiness failed')
            actual_schema=run(['docker','exec',project+'-api','node','-e',
                'const fs=require("fs"),path=require("path"),crypto=require("crypto");const root="/app/apps/api/prisma";let files=[];function walk(d){for(const x of fs.readdirSync(d)){const p=path.join(d,x);if(fs.statSync(p).isDirectory())walk(p);else if(x==="schema.prisma"||x.endsWith(".sql"))files.push(p)}}walk(root);const h=crypto.createHash("sha256");for(const p of files.sort()){h.update(path.relative(root,p));h.update(fs.readFileSync(p))}console.log(h.digest("hex"))']).stdout.strip()
            if actual_schema!=manifest['databaseSchemaHash']:raise ValueError('Signed schema hash does not match the runtime image')
            admin={'username':'fixtureadmin','email':'fixture@lab.invalid','name':'Fixture','password':'Fixture-only-'+uuid.uuid4().hex}
            run(['docker','exec','-i','-e','ADMIN_STDIN_JSON=true','-w','/app/apps/api',project+'-api','node','dist/bootstrap-admin.js'],input=json.dumps(admin))
            login=node('fetch("http://127.0.0.1:3000/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:'+json.dumps(json.dumps({'username':admin['username'],'password':admin['password']}))+'}).then(async r=>console.log(JSON.stringify({status:r.status,tokenPresent:!!(await r.json()).accessToken})))')
            if login['status']!=201 or not login['tokenPresent']:raise ValueError('Fresh bootstrap/login failed')
            sensitivity=node('''(async()=>{
                const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();
                const camera=await p.camera.create({data:{name:"Sensitivity fixture",ip:"0.0.0.0",sourceMode:"rtmp_push",username:"fixture",passwordEncrypted:"",enabled:false}});
                const response=await fetch("http://127.0.0.1:3000/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:''' + json.dumps(json.dumps({'username':admin['username'],'password':admin['password']})) + '''});
                const token=(await response.json()).accessToken;
                const headers={"Content-Type":"application/json",Authorization:"Bearer "+token};
                const update=await fetch("http://127.0.0.1:3000/cameras/"+camera.id,{method:"PATCH",headers,body:JSON.stringify({motionSensitivity:"alta"})});
                const invalid=await fetch("http://127.0.0.1:3000/cameras/"+camera.id,{method:"PATCH",headers,body:JSON.stringify({motionSensitivity:"invalid"})});
                const after=await p.camera.findUnique({where:{id:camera.id}});
                await p.camera.delete({where:{id:camera.id}});await p.$disconnect();
                console.log(JSON.stringify({defaultLevel:camera.motionSensitivity,updatedLevel:after.motionSensitivity,confidencePreserved:after.aiConfidence===camera.aiConfidence,updateStatus:update.status,invalidStatus:invalid.status}));
            })().catch(()=>process.exit(1))''')
            if sensitivity['defaultLevel']!='media' or sensitivity['updatedLevel']!='alta' or sensitivity['updateStatus']!=200 or sensitivity['invalidStatus']!=400 or not sensitivity['confidencePreserved']:
                print(json.dumps({'cameraSensitivityGate':sensitivity}),flush=True)
                raise ValueError('Camera sensitivity/default/validation/preservation gate failed')
            web=node('fetch("http://web:8080/").then(r=>console.log(JSON.stringify({status:r.status})))')
            publisher=subprocess.Popen(['docker','run','--rm','--name',project+'-publisher','--network',project+'_vms-net','--cpus','1',manifest['images']['api'],
                'ffmpeg','-hide_banner','-loglevel','error','-re','-f','lavfi','-i','testsrc2=size=640x360:rate=15','-c:v','libx264','-threads','1','-preset','ultrafast','-g','15','-t','150','-rtsp_transport','tcp','-f','rtsp','rtsp://mediamtx:8554/synthetic'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            time.sleep(3)
            started=node('fetch("http://ai-service:8000/analyze/start",{method:"POST",headers:{"Content-Type":"application/json","X-Service-Token":process.env.INTERNAL_SERVICE_TOKEN},body:JSON.stringify({camera_id:"synthetic-package-lab",rtsp_url:"rtsp://mediamtx:8554/synthetic",analysis_type:"motion",source_info:{simulationOnly:true}})}).then(async r=>console.log(JSON.stringify({status:r.status})))')
            if started['status']!=200:raise ValueError('Native analysis failed to start')
            lease=node('fetch("http://ai-service:8000/live-view/start/synthetic-package-lab",{method:"POST",headers:{"Content-Type":"application/json","X-Service-Token":process.env.INTERNAL_SERVICE_TOKEN},body:JSON.stringify({session_id:"package-lab",ttl_seconds:120,view_mode:"selected",simulation_mode:"motion"})}).then(async r=>console.log(JSON.stringify({status:r.status})))')
            if lease['status']!=200:raise ValueError('Simulation live-view lease failed')
            deadline=time.monotonic()+75
            while True:
                health=node('fetch("http://ai-service:8000/health").then(r=>r.json()).then(r=>console.log(JSON.stringify(r)))')
                processor=health['processors']['synthetic-package-lab']
                if processor['readiness']['ready'] and processor['capture_frames_enqueued']>=20:break
                if time.monotonic()>=deadline:
                    print(json.dumps({'captureReadiness':processor['readiness'],'receivedFrames':processor['capture_frames_enqueued']}),flush=True)
                    raise ValueError('Native capture did not receive synthetic frames within startup deadline')
                time.sleep(2)
            # Measure after capture is warm; startup waiting must not masquerade
            # as the effective steady-state analysis cadence.
            time.sleep(10)
            health=node('fetch("http://ai-service:8000/health").then(r=>r.json()).then(r=>console.log(JSON.stringify(r)))')
            processor=health['processors']['synthetic-package-lab']
            if not processor['readiness']['ready']:raise ValueError('Native capture lost readiness after warmup')
            run(['docker','exec',project+'-api','ffmpeg','-hide_banner','-loglevel','error','-rtsp_transport','tcp','-i','rtsp://mediamtx:8554/synthetic','-t','2','-c','copy','-y','/tmp/package-lab.mp4'])
            recorded=json.loads(run(['docker','exec',project+'-api','ffprobe','-v','error','-show_entries','stream=codec_name,width,height','-of','json','/tmp/package-lab.mp4']).stdout)
            hls=node('fetch("http://mediamtx:8888/synthetic/index.m3u8").then(async r=>console.log(JSON.stringify({status:r.status,playlist:(await r.text()).startsWith("#EXTM3U")})))')
            whep=node('fetch("http://mediamtx:8889/synthetic/whep",{method:"OPTIONS"}).then(r=>console.log(JSON.stringify({status:r.status})))')
            native=run(['docker','exec',project+'-ai-service','python','-c','import main,pathlib;assert main.__file__.endswith(".so");assert not list(pathlib.Path("/app").rglob("*.py"));print("native")']).stdout.strip()=='native'
            if web['status']!=200 or hls['status']!=200 or not hls['playlist'] or not native:raise ValueError('Runtime delivery validation failed')
            report={'commit':manifest['commit'],'freshIsolatedRuntime':True,'realDockerServices':True,'syntheticVideo':True,
                'productionModified':False,'signatureVerified':True,'databaseSchemaVerified':True,'sourceFreeAI':native,'readiness':ready,'bootstrapLogin':login,
                'web':web,'motion':{'configuredFps':processor['process_fps'],'receivedFrames':processor['capture_frames_enqueued'],'performance':processor['performance']},
                'cameraSensitivity':sensitivity,
                'recordedStreams':recorded['streams'],'hls':hls,'whepSignaling':whep,'physicalCameraOrCustomerICEValidated':False}
            args.report.write_text(json.dumps(report,indent=2));print(json.dumps(report))
        finally:
            if publisher is not None:
                subprocess.run(['docker','rm','-f',project+'-publisher'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                publisher.wait(timeout=15)
            subprocess.run(compose+['down','--volumes','--remove-orphans'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--bundle',type=Path,required=True);parser.add_argument('--public-key',type=Path,required=True)
    parser.add_argument('--commit',required=True);parser.add_argument('--report',type=Path,required=True)
    validate(parser.parse_args())
