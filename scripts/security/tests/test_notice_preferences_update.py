import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'deploy-viewing-update.py'
spec = importlib.util.spec_from_file_location('notice_deploy', path)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class NoticePreferenceMigrationTests(unittest.TestCase):
    def fixtures(self):
        name, (digest, _) = next(iter(deploy.NOTICE_PREFERENCE_MIGRATIONS.items()))
        old = {'hash': 'before', 'schema': 'model Camera {\n id String @id\n}\n', 'migrations': {'existing': 'same'}}
        new = {'hash': 'after', 'schema': 'model Camera {\n id String @id\n noticeSound String @default("attention")\n noticeDurationSeconds Int @default(10)\n}\n', 'migrations': {'existing': 'same', name: digest}}
        return old, new

    def test_only_reviewed_additive_preferences_are_allowed(self):
        old, new = self.fixtures()
        self.assertEqual(deploy.validate_sgp_policy_transition(old, new, 'after', deploy.NOTICE_PREFERENCE_MIGRATIONS), ['20261028120000_camera_notice_preferences'])

    def test_unreviewed_column_is_rejected(self):
        old, new = self.fixtures()
        new['schema'] = new['schema'].replace('id String @id', 'id String @id\n unrelated String')
        with self.assertRaises(ValueError):
            deploy.validate_sgp_policy_transition(old, new, 'after', deploy.NOTICE_PREFERENCE_MIGRATIONS)

    def test_changed_sql_or_existing_migration_is_rejected(self):
        for key in ['existing', '20261028120000_camera_notice_preferences']:
            old, new = self.fixtures()
            new['migrations'][key] = 'unreviewed'
            with self.assertRaises(ValueError):
                deploy.validate_sgp_policy_transition(old, new, 'after', deploy.NOTICE_PREFERENCE_MIGRATIONS)


if __name__ == '__main__':
    unittest.main()
