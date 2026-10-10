import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('viewing', Path(__file__).resolve().parents[1] / 'deploy-viewing-update.py')
viewing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(viewing)


class WebOnlyUpdateTests(unittest.TestCase):
    def test_unchanged_api_and_schema_are_allowed(self):
        viewing.validate_web_only_update({'images': {'api': {'imageId': 'same'}}}, {'Image': 'same'}, False)

    def test_api_change_is_rejected(self):
        with self.assertRaises(ValueError):
            viewing.validate_web_only_update({'images': {'api': {'imageId': 'other'}}}, {'Image': 'same'}, False)

    def test_even_approved_schema_migration_is_rejected(self):
        with self.assertRaises(ValueError):
            viewing.validate_web_only_update({'images': {'api': {'imageId': 'same'}}}, {'Image': 'same'}, True)


if __name__ == '__main__':
    unittest.main()
