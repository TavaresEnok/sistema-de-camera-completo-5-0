import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('package_builder',Path(__file__).parents[1]/'build-runtime-package.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)

class PackageSchemaTest(unittest.TestCase):
    def test_hash_covers_only_files_shipped_in_api_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'schema.prisma').write_text('schema')
            (root/'migrations/001').mkdir(parents=True)
            (root/'migrations/001/migration.sql').write_text('migration')
            expected=hashlib.sha256()
            for name in ['migrations/001/migration.sql','schema.prisma']:
                expected.update(name.encode());expected.update((root/name).read_bytes())
            self.assertEqual(builder.database_schema_hash(root),expected.hexdigest())
            (root/'rls').mkdir();(root/'rls/tenant-rls.sql').write_text('not shipped')
            self.assertEqual(builder.database_schema_hash(root),expected.hexdigest())
