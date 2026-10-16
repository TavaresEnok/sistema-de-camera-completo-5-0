import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('viewing_update', Path(__file__).resolve().parents[1] / 'deploy-viewing-update.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReviewedSgpTransition(unittest.TestCase):
    def fixtures(self):
        name = '20261015170000_sgp_service_private_camera_limit'
        previous = {'hash': 'previous', 'schema': 'model SgpService {\n id String\n}', 'migrations': {'old': 'unchanged'}}
        target = {'hash': 'target', 'schema': 'model SgpService {\n id String\n externalPlanId String @default("")\n privateCameraLimit Int @default(0)\n}', 'migrations': {'old': 'unchanged', name: module.SGP_POLICY_MIGRATIONS[name][0]}}
        return name, previous, target

    def test_exact_reviewed_additions(self):
        name, previous, target = self.fixtures()
        self.assertEqual(module.validate_sgp_policy_transition(previous, target, 'target'), [name])

    def test_same_actual_schema_can_reconcile_stale_metadata(self):
        _, previous, _ = self.fixtures()
        self.assertEqual(module.validate_sgp_policy_transition(previous, previous, 'previous'), [])

    def test_signed_schema_hash_must_match(self):
        _, previous, target = self.fixtures()
        with self.assertRaises(ValueError): module.validate_sgp_policy_transition(previous, target, 'wrong')

    def test_existing_migrations_cannot_change(self):
        _, previous, target = self.fixtures()
        target['migrations']['old'] = 'tampered'
        with self.assertRaises(ValueError): module.validate_sgp_policy_transition(previous, target, 'target')

    def test_unreviewed_and_tampered_additions_fail(self):
        name, previous, target = self.fixtures()
        target['migrations'][name] = 'tampered'
        with self.assertRaises(ValueError): module.validate_sgp_policy_transition(previous, target, 'target')
        target['migrations'] = {'old': 'unchanged', 'unknown': 'new'}
        with self.assertRaises(ValueError): module.validate_sgp_policy_transition(previous, target, 'target')

    def test_other_datamodel_changes_fail(self):
        _, previous, target = self.fixtures()
        target['schema'] = target['schema'].replace('id String', 'id Int')
        with self.assertRaises(ValueError): module.validate_sgp_policy_transition(previous, target, 'target')


if __name__ == '__main__': unittest.main()
