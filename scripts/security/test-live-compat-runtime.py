#!/usr/bin/env python3
"""Fresh disposable services and real codec fixtures; never touches production."""
import argparse
import json
import os
import re
from pathlib import Path
import secrets
import subprocess
import sys
import time


def run(args):
    prefix = 'compat-lab-' + secrets.token_hex(4)
    network = prefix + '-net'
    volume = prefix + '-storage'
    containers = []
    report = {'freshIsolatedRuntime': True, 'realDockerServices': True, 'syntheticVideo': True,
              'productionModified': False, 'cases': []}
    def docker(*cmd, input=None, timeout=180):
        result = subprocess.run(['docker', *cmd], input=input, text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            # Docker stderr can contain environment values: never echo it.
            safe_error = re.search(r'(?m)^(bootstrap_login_failed|urls_failed_[a-z0-9_-]+|hls_failed_[a-z0-9_-]+|media_not_advancing_[a-z0-9_-]+|encode_policy_wrong_[a-z0-9_-]+|bad_audio_not_isolated|healthy_audio_not_preserved|notice_[a-z0-9_-]+|real_motion_did_not_generate_notice)\s*$', result.stderr)
            if safe_error: print('fixture_failure: ' + safe_error.group(1), flush=True)
            raise RuntimeError('lab_operation_failed_' + str(result.returncode) + '_' + cmd[0])
        return result.stdout
    def start(name, image, env=None, command=None, extra=None):
        full = prefix + '-' + name
        cmd = ['run', '-d', '--name', full, '--network', network, '--network-alias', name]
        for key, value in (env or {}).items(): cmd += ['-e', key + '=' + value]
        cmd += extra or []
        cmd += [image, *(command or [])]
        docker(*cmd)
        containers.append(full)
        return full
    def node(script, input=None):
        return docker('exec', '-i', '-w', '/app/apps/api', api, 'node', '-e', script, input=input)
    try:
        docker('network', 'create', network)
        docker('volume', 'create', volume)
        docker('run', '--rm', '--user', '0', '--entrypoint', 'sh', '-v', volume + ':/storage', args.api,
               '-c', 'mkdir -p /storage/recordings; chown -R 1000:1000 /storage')
        secret = secrets.token_hex(24)
        postgres = start('postgres', 'postgres:16-alpine', {'POSTGRES_USER': 'lab', 'POSTGRES_DB': 'lab', 'POSTGRES_PASSWORD': secret})
        start('redis', 'redis:7-alpine')
        media = start('mediamtx', 'bluenviron/mediamtx:1-ffmpeg', extra=[
            '-v', str(Path(__file__).parent / 'tests/live-compat-mediamtx.yml') + ':/mediamtx.yml:ro'])
        start('ai-service', args.ai, {'API_BASE_URL': 'http://api:3000', 'INTERNAL_SERVICE_TOKEN': secret}, extra=['--cpus', '2'])
        for _ in range(60):
            check = subprocess.run(['docker', 'exec', postgres, 'pg_isready', '-U', 'lab'], capture_output=True)
            if check.returncode == 0: break
            time.sleep(1)
        media_ip = docker('inspect', media, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}').strip()
        env = {'DATABASE_URL': 'postgresql://lab:' + secret + '@postgres:5432/lab', 'REDIS_HOST': 'redis',
               'CAMERA_ALLOWED_CIDRS': media_ip + '/32',
               'JWT_SECRET': secrets.token_hex(32), 'CAMERA_SECRET_KEY': secrets.token_hex(32),
               'INTERNAL_SERVICE_TOKEN': secret, 'MEDIAMTX_API_USER': 'lab', 'MEDIAMTX_API_PASS': secret,
               'MEDIAMTX_AUTH_CALLBACK_TOKEN': secrets.token_hex(32),
               'MEDIAMTX_RTSP_INTERNAL_URL': 'rtsp://mediamtx:8554', 'MEDIAMTX_API_BASE_URL': 'http://mediamtx:9997',
               'AI_BASE_URL': 'http://ai-service:8000', 'RECORDINGS_ROOT': '/storage/recordings',
               'CLOUD_CONNECTOR_ENABLED': 'false', 'MEDIAMTX_WARM_PATHS_ON_BOOT': 'false',
               'MEDIAMTX_SOURCE_ON_DEMAND_START_TIMEOUT': '15s', 'GRID_SOURCE_PROFILE': 'camera',
               'MEDIAMTX_TRACK_HEALTH_ENABLED': 'false', 'MEDIAMTX_REAP_DUPLICATE_SESSIONS_ENABLED': 'false',
               'RTSP_SOURCE_SHARED_ENABLED': 'false'}
        api = start('api', args.api, env, extra=['-v', volume + ':/storage', '--cpus', '4'])
        start('web', args.web, extra=['--tmpfs', '/var/run:rw,noexec,nosuid,nodev,size=8m,uid=101,gid=101',
                                     '--tmpfs', '/var/cache/nginx:rw,noexec,nosuid,nodev,size=64m,uid=101,gid=101'])
        for _ in range(90):
            try:
                health = json.loads(node("fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(10000)}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"))
                if health.get('ready'): break
            except Exception: pass
            time.sleep(2)
        else: raise RuntimeError('fresh_api_not_ready')
        report['readiness'] = health
        print('fresh_runtime_ready', flush=True)
        report['databaseSchemaVerified'] = health['checks']['databaseSchema']['ok']
        # The runner image must carry no uncompiled proprietary AI source.
        native = docker('exec', prefix + '-ai-service', 'python', '-c',
                        'import main;from pathlib import Path;assert main.__file__.endswith(".so");assert not list(Path("/app").rglob("*.py"));print("native")')
        report['sourceFreeAI'] = native.strip() == 'native'
        report['web'] = json.loads(node("fetch('http://web:8080/').then(r=>console.log(JSON.stringify({status:r.status})))"))
        node("const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();Promise.all(Object.entries({'cloud.licenseStatus':'ACTIVE','cloud.lastSyncAt':new Date().toISOString()}).map(([key,value])=>p.systemSetting.upsert({where:{key},create:{key,value},update:{value}}))).finally(()=>p.$disconnect())")
        password = secrets.token_urlsafe(24)
        docker('exec', '-i', '-e', 'ADMIN_STDIN_JSON=true', api, 'node', '/app/apps/api/dist/bootstrap-admin.js',
               input=json.dumps({'username': 'labadmin', 'email': 'lab@example.invalid', 'name': 'Lab', 'password': password}))
        for name, bframes, broken in [('healthy', 0, False), ('bframes', 2, False), ('bad-audio', 2, True)]:
            codec = ['-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
                     '-g', '20', '-bf', str(bframes), '-c:a', 'aac']
            if broken: codec += ['-bsf:a', 'noise=amount=1']
            start('source-' + name, 'bluenviron/mediamtx:1-ffmpeg', command=[
                '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10',
                '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', *codec,
                '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://mediamtx:8554/fixture-' + name], extra=['--entrypoint', 'ffmpeg', '--cpus', '1'])
        time.sleep(3)
        # Setup fixture cameras in the actual fresh database, no UI/network discovery shortcuts.
        media_ip = docker('inspect', media, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}').strip()
        node("const {PrismaClient}=require('@prisma/client');const {CryptoService}=require('./dist/common/crypto/crypto.service');const p=new PrismaClient();const c=new CryptoService();const ip=" + json.dumps(media_ip) + ";Promise.all(['healthy','bframes','bad-audio'].map(n=>p.camera.create({data:{name:n,ip,rtspPort:8554,httpPort:80,username:'',passwordEncrypted:c.encrypt(''),rtspPath:'/fixture-'+n,sourceMode:'rtsp_pull',detectedVideoCodec:'h264',streamVideoCodec:'h264',detectedWidth:640,detectedHeight:360,detectedFps:10,streamWidth:640,streamHeight:360,streamFps:10,aiEnabled:false,recordingEnabled:false,enabled:true,status:'ONLINE'}}))).then(()=>console.log('fixture cameras created')).finally(()=>p.$disconnect())")
        print('fixtures_created', flush=True)
        script = r'''
const fs=require('fs');
(async()=>{
const input=JSON.parse(fs.readFileSync(0,'utf8'));const root='http://127.0.0.1:3000';
const l=await fetch(root+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'labadmin',password:input.password})});
const login=await l.json();if(!l.ok)throw Error('bootstrap_login_failed');
const cameras=await(await fetch(root+'/cameras',{headers:{Authorization:'Bearer '+login.accessToken}})).json();
const cases=[];
for(const name of ['healthy','bframes','bad-audio']){
 const camera=cameras.find(c=>c.name===name);
 for(const mode of ['grid','original-audio']){
  const started=Date.now();const r=await fetch(root+'/camera-stream/'+camera.id+'/urls?viewMode='+mode,{headers:{Authorization:'Bearer '+login.accessToken}});const u=await r.json();if(!r.ok)throw Error('urls_failed_'+name+'_'+r.status);
  const path=u.protocols.pathName;const hls='http://mediamtx:8888/'+path+'/index.m3u8';
  const m=await fetch(hls,{signal:AbortSignal.timeout(25000)});const text=await m.text();if(!m.ok)throw Error('hls_failed_'+name+'_'+mode+'_'+m.status);
  const child=new URL(text.split('\n').find(s=>s&&!s.startsWith('#')),hls);
  const samples=[];for(let i=0;i<2;i++){const p=await fetch(child);const t=await p.text();const seq=Number(t.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]);const seg=t.split('\n').filter(s=>s&&!s.startsWith('#')).at(-1);const s=await fetch(new URL(seg,child));samples.push({sequence:seq,status:s.status,bytes:(await s.arrayBuffer()).byteLength});if(!i)await new Promise(r=>setTimeout(r,3000));}
  if(samples.some(s=>s.status!==200||s.bytes<100)||samples[1].sequence<=samples[0].sequence)throw Error('media_not_advancing_'+name+'_'+mode);
  const expected=name!=='healthy';if(u.liveDiagnostics.videoEncoded!==expected)throw Error('encode_policy_wrong_'+name);
  if(mode==='original-audio'&&name==='bad-audio'&&u.liveDiagnostics.audioAvailable!==false)throw Error('bad_audio_not_isolated');
  if(mode==='original-audio'&&name!=='bad-audio'&&u.liveDiagnostics.audioAvailable!==true)throw Error('healthy_audio_not_preserved');
  cases.push({name,mode,path,videoEncoded:u.liveDiagnostics.videoEncoded,audioAvailable:u.liveDiagnostics.audioAvailable,startMs:Date.now()-started,samples});
 }
}
const auth={Authorization:'Bearer '+login.accessToken,'Content-Type':'application/json'};
const target=cameras.find(c=>c.name==='healthy');
const baseline=await(await fetch(root+'/cameras/motion-notices',{headers:auth})).json();
if(baseline.items.length)throw Error('notice_replayed_history');
const changed=await fetch(root+'/cameras/'+target.id,{method:'PATCH',headers:auth,body:JSON.stringify({recordingMode:'manual',motionNoticeEnabled:true})});
const saved=await changed.json();
if(!changed.ok||saved.recordingMode!=='manual'||saved.motionNoticeEnabled!==true||saved.aiEnabled!==true)throw Error('notice_manual_configuration_failed');
let notice=null;let cursor=baseline.cursor;
for(let i=0;i<30;i++){
 await new Promise(r=>setTimeout(r,2000));
 const response=await fetch(root+'/cameras/motion-notices?since='+encodeURIComponent(cursor),{headers:auth});
 const feed=await response.json();if(!response.ok)throw Error('notice_feed_failed');cursor=feed.cursor;
 notice=feed.items.find(e=>e.cameraId===target.id);if(notice)break;
}
if(!notice)throw Error('real_motion_did_not_generate_notice');
const state=await(await fetch(root+'/cameras/'+target.id,{headers:auth})).json();
if(state.recordingMode!=='manual'||state.recordingEnabled!==false)throw Error('notice_changed_recording');
const rec=await fetch(root+'/recordings?cameraId='+target.id,{headers:auth});if(!rec.ok)throw Error('notice_recordings_query_failed');
const recordings=await rec.json();
if((Array.isArray(recordings)?recordings:recordings.items||[]).length)throw Error('notice_started_recording');
const unauth=await fetch(root+'/cameras/motion-notices');if(unauth.status!==401)throw Error('notice_requires_authentication');
const stopped=await fetch(root+'/cameras/'+target.id,{method:'PATCH',headers:auth,body:JSON.stringify({motionNoticeEnabled:false})});
if(!stopped.ok)throw Error('notice_disable_failed');
const after=await(await fetch('http://ai-service:8000/health')).json();
if(after.active_processors?.includes(target.id))throw Error('notice_detector_not_stopped');
console.log(JSON.stringify({bootstrapLogin:{status:l.status,tokenPresent:!!login.accessToken},cases,hls:{status:200},motionNotices:{realMotionEvent:true,manualPreserved:true,recordingNotStarted:true,authenticationRequired:true,disabledDetectorStopped:true}}));
})().catch(e=>{console.error(e.message);process.exitCode=1});
'''
        report.update(json.loads(node(script, input=json.dumps({'password': password}))))
        for case in report['cases']:
            path = case.pop('path')
            probe = json.loads(docker('exec', media, 'ffprobe', '-v', 'error', '-rtsp_transport', 'tcp',
                '-read_intervals', '%+1', '-show_entries', 'stream=codec_type,codec_name,width,height,has_b_frames,r_frame_rate',
                '-of', 'json', 'rtsp://127.0.0.1:8554/' + path))
            case['deliveredTracks'] = probe.get('streams', [])
            video = next((s for s in case['deliveredTracks'] if s.get('codec_type') == 'video'), {})
            if video.get('codec_name') != 'h264' or video.get('has_b_frames') != 0:
                raise RuntimeError('delivered_video_not_browser_compatible')
        report['commit'] = args.commit
        if args.output: args.output.write_text(json.dumps(report, indent=2))
        print(json.dumps(report))
    finally:
        if args.keep_failed and sys.exc_info()[0]:
            print('Retained isolated diagnostic containers: ' + prefix, flush=True)
            raise
        for container in reversed(containers):
            subprocess.run(['docker', 'rm', '-f', '-v', container], capture_output=True)
        subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True)
        subprocess.run(['docker', 'network', 'rm', network], capture_output=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['api', 'web', 'ai', 'commit']: parser.add_argument('--' + name, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--keep-failed', action='store_true')
    run(parser.parse_args())
