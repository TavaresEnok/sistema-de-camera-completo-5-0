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

    def test_passage_count_transition_only_allows_reviewed_model_and_column(self):
        base = 'model Camera {\n  id String @id\n  name String\n}\n'
        target = ('model Camera {\n  id String @id\n  name String\n  /// taxa\n  countingFps Int?\n'
                  '  passageCounts PassageCount[]\n}\nmodel PassageCount {\n  id String @id\n  count Int\n}\n')
        digest = viewing.PASSAGE_COUNT_MIGRATIONS['20261110180000_passage_count'][0]
        previous = {'schema': base, 'migrations': {'a': '1'}}
        image = {'hash': 'h', 'schema': target, 'migrations': {'a': '1', '20261110180000_passage_count': digest}}
        self.assertEqual(viewing.validate_sgp_policy_transition(previous, image, 'h', viewing.PASSAGE_COUNT_MIGRATIONS, viewing.PASSAGE_COUNT_MODELS),
                         ['20261110180000_passage_count'])
        # Sem o modelo liberado, o modelo novo é recusado.
        with self.assertRaises(ValueError):
            viewing.validate_sgp_policy_transition(previous, image, 'h', viewing.PASSAGE_COUNT_MIGRATIONS)
        # Qualquer outra coluna nova em Camera é recusada.
        sneaky = dict(image, schema=target.replace('  countingFps Int?\n', '  countingFps Int?\n  extra Int?\n'))
        with self.assertRaises(ValueError):
            viewing.validate_sgp_policy_transition(previous, sneaky, 'h', viewing.PASSAGE_COUNT_MIGRATIONS, viewing.PASSAGE_COUNT_MODELS)
        # Migração com hash diferente do revisado é recusada.
        changed = dict(image, migrations={'a': '1', '20261110180000_passage_count': 'outro'})
        with self.assertRaises(ValueError):
            viewing.validate_sgp_policy_transition(previous, changed, 'h', viewing.PASSAGE_COUNT_MIGRATIONS, viewing.PASSAGE_COUNT_MODELS)
        # Migração existente alterada é recusada.
        with self.assertRaises(ValueError):
            viewing.validate_sgp_policy_transition(previous, dict(image, migrations={'a': '2', '20261110180000_passage_count': digest}), 'h',
                                                   viewing.PASSAGE_COUNT_MIGRATIONS, viewing.PASSAGE_COUNT_MODELS)

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
