# Appended to the signature verifier by the vendor's package builder. This
# fragment is not run independently: PUBLIC_RELEASE_KEY and extract_verified
# are anchored in the hash-pinned bootstrap delivered by Central.
import ssl
import urllib.parse
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        return None

def install_signed_runtime():
    central=os.environ.get('DRAC_CENTRAL_URL','').rstrip('/')
    parsed=urllib.parse.urlsplit(central)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Central HTTPS address required')
    identity=os.environ.get('DRAC_INSTALLATION_ID','')
    license_key=os.environ.get('DRAC_LICENSE_KEY','')
    commit=os.environ.get('DRAC_INSTALLER_COMMIT','')
    if not identity or not license_key or '\n' in identity+license_key:raise ValueError('Installation credentials required')
    headers={'X-DRAC-Installation-Id':identity,'X-DRAC-License-Key':license_key}
    opener=urllib.request.build_opener(NoRedirect,urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    request=urllib.request.Request(central+'/api/agent/artifacts/claim',data=b'{}',headers={**headers,'Content-Type':'application/json'},method='POST')
    with opener.open(request,timeout=30) as response:grant=json.loads(response.read(8192))
    if grant.get('commit')!=commit or not isinstance(grant.get('size'),int) or not 0<grant['size']<=MAX_BYTES:raise ValueError('Approved package mismatch')
    token=grant.get('token','')
    if not isinstance(token,str) or len(token)!=43 or any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-' for c in token):raise ValueError('Invalid temporary artifact grant')
    with tempfile.TemporaryDirectory(prefix='drac-signed-install-') as temporary:
        stage=Path(temporary);bundle=stage/'runtime.tar.gz';key=stage/'release-public.pem'
        key.write_text(PUBLIC_RELEASE_KEY);os.chmod(key,0o600)
        digest=hashlib.sha256();received=0
        request=urllib.request.Request(central+'/api/agent/artifacts/download',headers={**headers,'X-DRAC-Artifact-Grant':token})
        with opener.open(request,timeout=30) as response,bundle.open('xb') as output:
            while chunk:=response.read(1024*1024):
                received+=len(chunk)
                if received>grant['size']:raise ValueError('Oversized package download')
                digest.update(chunk);output.write(chunk)
        if received!=grant['size'] or digest.hexdigest()!=grant.get('sha256'):raise ValueError('Runtime download checksum rejected')
        extract_verified(bundle,key,stage/'verified',commit)
        # Retain only the public trust anchor for later signed updates.
        shutil.copyfile(key,stage/'verified/runtime/infra/release-public.pem')
        environment={**os.environ,'DRAC_VERIFIED_RUNTIME_DIR':str(stage/'verified')}
        subprocess.run(['bash',str(stage/'verified/runtime/scripts/install-drac.sh')],env=environment,check=True)

try:install_signed_runtime()
except Exception:
    raise SystemExit('Não foi possível instalar o pacote aprovado. Confira a conexão e a autorização na Central.')
