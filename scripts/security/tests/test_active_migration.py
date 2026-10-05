import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('migration',Path(__file__).resolve().parents[1]/'migrate-local-runtime.py')
migration=importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)

class ActiveMigrationTests(unittest.TestCase):
    def test_empty_pilot_remains_default(self):
        self.assertEqual(migration.reviewed_camera_count('0',0),0)
        with self.assertRaises(ValueError):migration.reviewed_camera_count('34',0)

    def test_active_migration_requires_exact_reviewed_count(self):
        self.assertEqual(migration.reviewed_camera_count('34',34),34)
        for count,expected in [('35',34),('33',34),('error',34),('0',-1)]:
            with self.subTest(count=count,expected=expected):
                with self.assertRaises(ValueError):migration.reviewed_camera_count(count,expected)

if __name__=='__main__':unittest.main()
