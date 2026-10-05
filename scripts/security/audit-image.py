#!/usr/bin/env python3
"""Inspect every Docker image layer, including files hidden by later layers."""
import json
from pathlib import PurePosixPath
import sys
import tarfile

with tarfile.open(sys.argv[1], 'r:*') as archive:
    manifest = json.load(archive.extractfile('manifest.json'))
    violations = []
    layers = {layer for image in manifest for layer in image['Layers']}
    for layer in sorted(layers):
        with tarfile.open(fileobj=archive.extractfile(layer), mode='r|*') as content:
            for entry in content:
                name = entry.name.lstrip('./')
                path = PurePosixPath(name)
                if '.git' in path.parts or path.name == '.env' or name.startswith(('app/apps/central/', 'app/apps/api/src/', 'app/apps/web/src/')):
                    violations.append(name)
                if name.startswith(('app/detectors/', 'app/trackers/', 'source/', 'build/cython/')) and name.endswith(('.py', '.pyc', '.c', '.map')):
                    violations.append(name)
                if name.startswith('app/') and len(path.parts) == 2 and path.suffix in ('.py', '.pyc'):
                    violations.append(name)
                if name.startswith('app/apps/api/') and 'node_modules' not in path.parts and path.suffix in ('.ts', '.map'):
                    violations.append(name)
                if name.startswith('usr/share/nginx/html/') and path.suffix == '.map':
                    violations.append(name)
    print(json.dumps({'layersInspected': len(layers), 'forbiddenFiles': sorted(set(violations))}, indent=2))
    if violations:
        raise SystemExit(1)
