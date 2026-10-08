import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('viewing', Path(__file__).resolve().parents[1] / 'deploy-viewing-update.py')
viewing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(viewing)


class RecordingChoiceMigrationTests(unittest.TestCase):
    def test_legacy_shutdown_restore_is_conditional_and_manual_requires_active_timer(self):
        statements = []
        viewing.sql = lambda statement: statements.append(statement) or '1'
        snapshot = {'at': '2026-10-08T15:00:00+00:00', 'cameras': [
            {'id': '12345678-1234-1234-1234-123456789abc', 'enabled': True, 'recordingEnabled': True, 'recordingMode': 'manual'},
            {'id': '22345678-1234-1234-1234-123456789abc', 'enabled': True, 'recordingEnabled': True, 'recordingMode': 'continuous'},
            {'id': '32345678-1234-1234-1234-123456789abc', 'enabled': True, 'recordingEnabled': False, 'recordingMode': 'manual'},
        ]}
        self.assertEqual(viewing.restore_legacy_shutdown(snapshot), 2)
        self.assertEqual(len(statements), 2)
        self.assertIn('"ManualRecordingSession"', statements[0])
        self.assertNotIn('"ManualRecordingSession"', statements[1])
        for statement in statements:
            self.assertIn('"AuditLog"', statement)
            self.assertIn('c."recordingEnabled"=false', statement)
            self.assertIn('c.enabled=true', statement)

    def test_unexpected_snapshot_is_not_executed(self):
        viewing.sql = lambda _: self.fail('Must not execute malformed identity')
        with self.assertRaises(ValueError):
            viewing.restore_legacy_shutdown({'at': '2026-10-08', 'cameras': [
                {'id': "invalid'", 'enabled': True, 'recordingEnabled': True, 'recordingMode': 'continuous'},
            ]})


if __name__ == '__main__':
    unittest.main()
