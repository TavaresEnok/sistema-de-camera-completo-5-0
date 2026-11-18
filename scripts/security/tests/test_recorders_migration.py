import hashlib
import importlib.util
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('deploy', ROOT / 'scripts/security/deploy-viewing-update.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

def schema(previous=False):
    base = '4cea8f88652cb8c9c3a9f1d3ac8a926d85b64899'
    paths = subprocess.check_output(['git', '-C', str(ROOT), 'ls-tree', '-r', '--name-only', base, 'apps/api/prisma'], text=True).splitlines() if previous else [str(p.relative_to(ROOT)) for p in (ROOT / 'apps/api/prisma').rglob('*') if p.is_file()]
    paths = [p for p in paths if p.endswith('.sql') or p.endswith('/schema.prisma')]
    digest = hashlib.sha256(); migrations = {}; content = ''
    for p in sorted(paths):
        data = subprocess.check_output(['git', '-C', str(ROOT), 'show', f'{base}:{p}']) if previous else (ROOT / p).read_bytes()
        relative = p.removeprefix('apps/api/prisma/')
        digest.update(relative.encode()); digest.update(data)
        if p.endswith('/schema.prisma'): content = data.decode()
        if p.endswith('/migration.sql'): migrations[p.split('/')[-2]] = hashlib.sha256(data).hexdigest()
    return {'hash': digest.hexdigest(), 'schema': content, 'migrations': migrations}

class RecorderMigrationTest(unittest.TestCase):
    def test_only_reviewed_additions(self):
        old, new = schema(True), schema()
        self.assertEqual(deploy.validate_sgp_policy_transition(old, new, new['hash'], deploy.RECORDERS_MIGRATIONS, deploy.RECORDERS_MODELS), ['20261116140000_recorders'])
    def test_rejects_other_changes(self):
        old, new = schema(True), schema()
        new['schema'] = new['schema'].replace('aiConfidence Int @default(70)', 'aiConfidence Int @default(99)')
        with self.assertRaises(ValueError): deploy.validate_sgp_policy_transition(old, new, new['hash'], deploy.RECORDERS_MIGRATIONS, deploy.RECORDERS_MODELS)
    def test_rejects_changed_sql(self):
        old, new = schema(True), schema()
        new['migrations']['20261116140000_recorders'] = '0' * 64
        with self.assertRaises(ValueError): deploy.validate_sgp_policy_transition(old, new, new['hash'], deploy.RECORDERS_MIGRATIONS, deploy.RECORDERS_MODELS)

if __name__ == '__main__': unittest.main()
