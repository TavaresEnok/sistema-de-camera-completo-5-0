import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('package_builder',Path(__file__).parents[1]/'build-runtime-package.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)

class PackageSchemaTest(unittest.TestCase):
    def test_notice_transition_changes_only_its_field_and_additive_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'migrations/001').mkdir(parents=True)
            (root/'migrations/001/migration.sql').write_text('existing migration')
            (root/'schema.prisma').write_text('model Camera {\n}\n')
            old=builder.database_schema_hash(root)
            (root/'schema.prisma').write_text('model Camera {\n  motionNoticeEnabled    Boolean      @default(false)\n}\n')
            (root/'migrations/20261006220000_camera_motion_notice').mkdir()
            (root/'migrations/20261006220000_camera_motion_notice/migration.sql').write_text('add notice field')
            self.assertEqual(builder.database_schema_hash(root,previous_notice_schema=True),old)
            self.assertNotEqual(builder.database_schema_hash(root),old)

    def test_reviewed_transition_changes_only_one_field_and_its_additive_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'schema.prisma').write_text('model Camera {\n}\n')
            (root/'migrations/001').mkdir(parents=True)
            (root/'migrations/001/migration.sql').write_text('old migration')
            old=builder.database_schema_hash(root)
            (root/'schema.prisma').write_text('model Camera {\n  motionSensitivity      String       @default("media")\n}\n')
            (root/'migrations/20261006190000_camera_motion_sensitivity').mkdir()
            (root/'migrations/20261006190000_camera_motion_sensitivity/migration.sql').write_text('add field')
            self.assertEqual(builder.database_schema_hash(root,True),old)
            self.assertNotEqual(builder.database_schema_hash(root),old)
            (root/'migrations/001/migration.sql').write_text('changed old migration')
            self.assertNotEqual(builder.database_schema_hash(root,True),old)

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
