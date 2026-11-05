import unittest
from inference_capacity import global_request_limit


class CapacityTests(unittest.TestCase):
    def test_default(self):
        self.assertEqual(global_request_limit(), 2)

    def test_previous_choices_unchanged(self):
        for value in (1, 3, 5, 7, 8):
            self.assertEqual(global_request_limit(value), value)

    def test_twelve_requests_not_silently_clipped(self):
        self.assertEqual(global_request_limit(12), 12)
        self.assertEqual(global_request_limit('12'), 12)

    def test_bounded(self):
        self.assertEqual(global_request_limit(0), 1)
        self.assertEqual(global_request_limit(-10), 1)
        self.assertEqual(global_request_limit(1000), 32)

    def test_invalid_uses_safe_default(self):
        for value in (None, 'bad', float('nan'), float('inf')):
            self.assertEqual(global_request_limit(value), 2)


if __name__ == '__main__':
    unittest.main()
