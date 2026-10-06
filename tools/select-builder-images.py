#!/usr/bin/env python3
"""Recover only reviewed vendor build dependencies from an OCI backup."""
import io
import json
import sys
import tarfile

source, destination = sys.argv[1:3]
digests = set(sys.argv[3:])
metadata = {}
with tarfile.open(source, 'r|gz') as archive:
    for member in archive:
        if member.isfile() and member.size < 200000:
            raw = archive.extractfile(member).read()
            try:
                metadata[member.name] = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                pass
index = metadata['index.json']
selected = [item for item in index['manifests'] if item['digest'] in digests]
assert len(selected) == len(digests), 'Missing reviewed builder image'
wanted = {'oci-layout'}
def visit(digest):
    name = 'blobs/sha256/' + digest.split(':')[1]
    if name in wanted:
        return
    wanted.add(name)
    value = metadata.get(name, {})
    for item in value.get('manifests', []) + value.get('layers', []):
        visit(item['digest'])
    if isinstance(value.get('config'), dict) and 'digest' in value['config']:
        visit(value['config']['digest'])
for item in selected:
    visit(item['digest'])
index['manifests'] = selected
with tarfile.open(destination, 'w') as output:
    raw = json.dumps(index).encode()
    member = tarfile.TarInfo('index.json')
    member.size = len(raw)
    output.addfile(member, io.BytesIO(raw))
    with tarfile.open(source, 'r|gz') as archive:
        for member in archive:
            if member.name in wanted:
                assert member.isfile()
                output.addfile(member, archive.extractfile(member))
print(json.dumps({'selectedImages': len(selected), 'selectedBlobs': len(wanted)}))
