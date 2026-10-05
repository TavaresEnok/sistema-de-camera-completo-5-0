#!/usr/bin/env python3
"""Pre-seed a verified license using an isolated candidate API container.

The Docker Unix API carries existing environment credentials in memory, not in
command-line flags, files or printed inspection output. Does not restart any
production container or alter camera modes.
"""
import argparse
import http.client
import ipaddress
import json
from pathlib import Path
import socket
from urllib.parse import urlparse


class DockerConnection(http.client.HTTPConnection):
    def __init__(self):super().__init__('localhost',timeout=60)
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout);self.sock.connect('/var/run/docker.sock')


def api(method,path,body=None,raw=False):
    connection=DockerConnection()
    try:
        payload=json.dumps(body).encode() if body is not None else None
        connection.request(method,path,payload,{'Content-Type':'application/json'} if payload else {})
        response=connection.getresponse();data=response.read()
        if response.status>=400:raise RuntimeError('Docker operation refused: '+str(response.status))
        return data if raw else json.loads(data) if data else None
    finally:connection.close()


def run(args):
    directory=args.license_directory.resolve()
    if not (directory/'device.pem').is_file() or not (directory/'trusted-keys.json').is_file():raise ValueError('Protected device identity/trust store required')
    existing=api('GET','/containers/'+args.container+'/json')
    network=existing['HostConfig']['NetworkMode']
    if network in ['host','none','default','bridge']:raise ValueError('Explicit existing application network required')
    environment=[x for x in existing['Config']['Env'] if x.split('=',1)[0] not in ['CLOUD_LICENSE_VERIFICATION','CLOUD_DEVICE_KEY_FILE','CLOUD_LICENSE_KEYS_FILE']]
    extra_hosts=list(existing['HostConfig'].get('ExtraHosts') or [])
    if args.central_url:
        parsed=urlparse(args.central_url)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ['', '/']:
            raise ValueError('A credential-free HTTPS Central origin is required')
        environment=[x for x in environment if not x.startswith('CLOUD_API_URL=')]
        environment.append('CLOUD_API_URL='+args.central_url.rstrip('/'))
        if args.central_address:
            address=str(ipaddress.ip_address(args.central_address))
            extra_hosts=[x for x in extra_hosts if not x.startswith(parsed.hostname+':')]
            extra_hosts.append(parsed.hostname+':'+address)
    elif args.central_address:raise ValueError('Central address requires an HTTPS origin')
    environment+=['CLOUD_LICENSE_VERIFICATION=required','CLOUD_DEVICE_KEY_FILE=/run/drac-license/device.pem','CLOUD_LICENSE_KEYS_FILE=/run/drac-license/trusted-keys.json']
    created=api('POST','/containers/create',{'Image':args.image,'User':'1000:1000','Env':environment,
        'Cmd':['node','/app/apps/api/dist/common/licensing/prepare-migration.js'],
        'HostConfig':{'NetworkMode':network,'Binds':[str(directory)+':/run/drac-license:ro'],
                      'ExtraHosts':extra_hosts,
                      'ReadonlyRootfs':True,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],
                      'Tmpfs':{'/tmp':'rw,noexec,nosuid,nodev,size=64m'},'Memory':256*1024*1024,'NanoCpus':1000000000}})
    identity=created['Id']
    try:
        api('POST','/containers/'+identity+'/start')
        result=api('POST','/containers/'+identity+'/wait?condition=not-running')
        if result.get('StatusCode')!=0:raise RuntimeError('License preflight failed; production API was not replaced')
        print(json.dumps({'prepared':True,'signatureVerified':True,'productionRestarted':False}))
    finally:
        # Exact task-owned ephemeral container only, never a production name.
        api('DELETE','/containers/'+identity+'?force=true')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--container',default='vms-api')
    parser.add_argument('--image',required=True);parser.add_argument('--license-directory',type=Path,required=True)
    parser.add_argument('--central-url');parser.add_argument('--central-address')
    try:run(parser.parse_args())
    except Exception as error:raise SystemExit('License preparation refused: '+str(error))
