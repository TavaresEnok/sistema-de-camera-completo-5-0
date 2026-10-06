import unittest
import numpy as np
from detectors.motion import MotionDetector, _NIVEL_POR_NOME
from stream_processor import StreamProcessor
from runtime_profiles import MOTION_PROFILE


class SensitivityTests(unittest.TestCase):
    def test_default_is_unchanged(self):
        detector = MotionDetector()
        self.assertIsNone(detector._zone_factor_map)
        self.assertEqual(detector._minimum_zone_component_pixels, detector.min_component_pixels)

    def test_camera_levels_change_real_threshold(self):
        levels = [MotionDetector(cfg={'sensitivity': level}) for level in ('alta', 'media', 'baixa')]
        self.assertLess(levels[0]._minimum_zone_component_pixels, levels[1]._minimum_zone_component_pixels)
        self.assertLess(levels[1]._minimum_zone_component_pixels, levels[2]._minimum_zone_component_pixels)
        self.assertTrue(levels[0]._all_monitored_high)

    def test_explicit_zone_overrides_camera_even_when_medium(self):
        zone = {'kind': 'include', 'sensitivity': 'media', 'points': [[0, 0], [1, 0], [1, 1], [0, 1]]}
        detector = MotionDetector(cfg={'sensitivity': 'alta'}, zones=[zone])
        self.assertIsNone(detector._zone_factor_map)
        self.assertEqual(detector._minimum_zone_component_pixels, detector.min_component_pixels)

    def test_inheritance_and_existing_zone_level_are_preserved(self):
        zone = {'kind': 'include', 'points': [[0, 0], [1, 0], [1, 1], [0, 1]]}
        detector = MotionDetector(cfg={'sensitivity': 'alta'}, zones=[zone])
        self.assertTrue(detector._all_monitored_high)
        zone['sensitivity'] = 'baixa'
        detector.set_zones([zone])
        self.assertTrue(np.all(detector._zone_factor_map == _NIVEL_POR_NOME['baixa']))

    def test_invalid_camera_level_falls_back_safely(self):
        self.assertIsNone(MotionDetector(cfg={'sensitivity': 'invalid'})._zone_factor_map)


class RecordingQosTests(unittest.TestCase):
    def processor(self, simulation=False):
        # No stream or model is opened by construction.
        return StreamProcessor('unit-camera', 'rtsp://example.invalid/test', 'http://example.invalid',
                               'unit-token', analysis_type='general', source_info={'simulationOnly': simulation})

    def test_recording_is_independent_of_grid_and_selection(self):
        processor = self.processor()
        processor.adaptive_enabled = False
        for mode in ('grid', 'selected', 'base'):
            processor._apply_qos_mode(mode)
            self.assertEqual(processor.current_qos_mode, 'base')
            self.assertEqual(processor.advanced_process_fps, processor.base_advanced_process_fps)
            self.assertEqual(processor.process_fps, max(processor.base_process_fps, MOTION_PROFILE['detection_fps']))
            self.assertEqual(processor.frame_width, processor.base_frame_width)

    def test_preview_simulation_still_has_bounded_qos(self):
        processor = self.processor(simulation=True)
        processor.adaptive_enabled = False
        processor._apply_qos_mode('grid')
        self.assertEqual(processor.current_qos_mode, 'grid')
        self.assertEqual(processor.advanced_process_fps, processor.grid_advanced_process_fps)

    def test_sensitivity_does_not_change_fps(self):
        processor = self.processor()
        processor.adaptive_enabled = False
        processor._apply_qos_mode('grid')
        before = (processor.process_fps, processor.advanced_process_fps)
        processor.motion_detector = MotionDetector(cfg={'sensitivity': 'alta'})
        processor._apply_qos_mode('grid')
        self.assertEqual(before, (processor.process_fps, processor.advanced_process_fps))


if __name__ == '__main__':
    unittest.main()
