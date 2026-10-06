import csv
import json
import re
import subprocess

fields = ['id', 'name', 'enabled', 'recordingEnabled', 'recordingMode', 'motionTrigger',
          'detectionZones', 'recordingObjectClasses', 'aiSensitivity', 'aiConfidence', 'aiObjectClasses', 'objectMode']
image = subprocess.check_output(['docker','inspect','vms-postgres','--format','{{.Image}}'],text=True).strip()
dump = '/opt/drac/infra/backups/runtime-updates/dd17017e602798a6c21d62f4b6aadbf755c0425a/database.before.dump'
raw = subprocess.check_output(['docker','run','--rm','--network','none','-v',dump+':/backup.dump:ro',
                              '--entrypoint','pg_restore',image,'--data-only','--table=Camera','--file=-','/backup.dump'],text=True)
columns = None
before = {}
for line in raw.splitlines():
    if line.startswith('COPY public."Camera" '):
        columns = [name.strip().strip('"') for name in line.split('(',1)[1].split(')',1)[0].split(',')]
        continue
    if columns is None:
        continue
    if line == '\\.':
        break
    row = dict(zip(columns,line.split('\t')))
    selected = {}
    for field in fields:
        value = row[field]
        if value == '\\N':
            selected[field] = None
            continue
        value = re.sub(r'\\([\\tnr])',lambda m: {'t':'\t','n':'\n','r':'\r','\\':'\\'}[m[1]],value)
        if field in ('enabled','recordingEnabled'):
            value = value == 't'
        elif field == 'aiConfidence':
            value = int(value)
        elif field == 'detectionZones':
            value = json.loads(value)
        elif field in ('recordingObjectClasses','aiObjectClasses'):
            value = next(csv.reader([value[1:-1]])) if value != '{}' else []
        selected[field] = value
    before[row['id']] = selected
selector = '{'+','.join(field+':true' for field in fields)+'}'
source = 'const {PrismaClient}=require("/app/apps/api/node_modules/@prisma/client");const p=new PrismaClient();p.camera.findMany({select:'+selector+'}).then(x=>console.log(JSON.stringify(x))).finally(()=>p.$disconnect())'
current = json.loads(subprocess.check_output(['docker','exec','vms-api','node','-e',source],text=True))
changes = []
for row in current:
    old = before.get(row['id'],{})
    differences = {key:{'before':old.get(key),'after':row.get(key)} for key in fields if old.get(key)!=row.get(key)}
    if differences:
        changes.append({'camera':row['name'],'changes':differences})
print(json.dumps({'changedCameras':changes},ensure_ascii=False))
