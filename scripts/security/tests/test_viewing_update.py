import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('viewing', Path(__file__).resolve().parents[1] / 'deploy-viewing-update.py')
viewing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(viewing)


class RecordingChoiceMigrationTests(unittest.TestCase):
    def test_sgp_transition_requires_exact_digest_and_separate_approval(self):
        body = {'databaseSchemaHash': 'new', 'reviewedSchemaTransition': {
            'from': 'old', 'kind': 'additive', 'migration': '20261010160000_sgp_integration',
            'migrationSha256': 'ad8156582c068dbfb207c2516d5f144149e0e9229ecb9edebb84de7c8e08b2b5'}}
        self.assertTrue(viewing.allow_schema_transition('old', body, sgp_approved=True))
        for options in [{}, {'approved': True}, {'object_notice_approved': True}]:
            with self.assertRaises(ValueError):
                viewing.allow_schema_transition('old', body, **options)
        body['reviewedSchemaTransition']['migrationSha256'] = 'unreviewed'
        with self.assertRaises(ValueError):
            viewing.allow_schema_transition('old', body, sgp_approved=True)

    def test_notice_transition_requires_separate_explicit_approval(self):
        body = {'databaseSchemaHash': 'new', 'reviewedSchemaTransition': {
            'from': 'old', 'kind': 'additive', 'migration': '20261008210000_camera_object_notice'}}
        self.assertTrue(viewing.allow_schema_transition('old', body, object_notice_approved=True))
        for approved, object_approved in [(False, False), (True, False)]:
            with self.assertRaises(ValueError):
                viewing.allow_schema_transition('old', body, approved, object_approved)

    def test_additive_schema_needs_exact_signed_transition_and_explicit_approval(self):
        body = {'databaseSchemaHash': 'new', 'reviewedSchemaTransition': {
            'from': 'old', 'kind': 'additive', 'migration': '20261008173000_camera_detector_percentage'}}
        self.assertFalse(viewing.allow_schema_transition('new', body))
        self.assertTrue(viewing.allow_schema_transition('old', body, True))
        for current, approved in [('old', False), ('other', True)]:
            with self.assertRaises(ValueError):
                viewing.allow_schema_transition(current, body, approved)
        body['reviewedSchemaTransition']['migration'] = 'unreviewed'
        with self.assertRaises(ValueError):
            viewing.allow_schema_transition('old', body, True)

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
