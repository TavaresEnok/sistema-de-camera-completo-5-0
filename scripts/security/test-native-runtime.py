#!/usr/bin/env python3
"""Test the actual source-free image. Static source assertions run separately.

Usage: mount this script and the normal tests in the compiled image, then run
python /security/test-native-runtime.py. No source-code fallback is mounted.
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0,'/tests')
sys.path.insert(0,'/app')
MODULES=['test_motion_detector','test_visual_tracking','test_object_detector','test_object_detector_regions',
         'test_object_policy','test_stage_timings','test_tripwire','test_capture_cadence','test_capture_rate_guard','test_confirm_motion']
SKIP={
    'test_motion_detector.TestFlagsDeAmbiente.test_env_liga_plano_y_e_desliga_scene_change':'Compiled extensions require a process restart; replaced with fresh-process test.',
    'test_capture_rate_guard.TestStreamProcessorWiring.test_denuncia_com_warning_e_expoe_no_estado_da_captura':'Static source test, executed separately against the reviewed source.',
    'test_capture_rate_guard.TestStreamProcessorWiring.test_importa_e_instancia_o_guarda':'Static source test, executed separately against the reviewed source.',
    'test_capture_rate_guard.TestStreamProcessorWiring.test_laco_de_captura_contabiliza_cada_frame_consumido':'Static source test, executed separately against the reviewed source.',
}

def flatten(suite):
    for case in suite:
        if isinstance(case,unittest.TestSuite):yield from flatten(case)
        else:yield case

class NativeRuntimeChecks(unittest.TestCase):
    def test_flags_apply_when_process_starts(self):
        environment={**os.environ,'MOTION_LUMA_PLANE':'true','MOTION_SCENE_CHANGE_REPORT':'false','MOTION_MAX_BOXES':'2',
                     'MOTION_ILLUMINATION_COMPENSATION':'false','MOTION_PHOTOMETRIC_SCENE_SUPPRESSION':'false'}
        script='import json,runtime_profiles;print(json.dumps(runtime_profiles.MOTION_PROFILE))'
        result=subprocess.run([sys.executable,'-c',script],env=environment,check=True,capture_output=True,text=True)
        profile=json.loads(result.stdout)
        self.assertTrue(profile['motion_luma_plane']);self.assertFalse(profile['motion_scene_change_report'])
        self.assertEqual(profile['motion_max_boxes'],2);self.assertFalse(profile['motion_illumination_compensation'])
        self.assertFalse(profile['motion_photometric_scene_suppression'])

    def test_our_modules_are_native_and_no_source_is_present(self):
        import main,detectors.object_detector,trackers.visual_bridge
        for module in [main,detectors.object_detector,trackers.visual_bridge]:self.assertTrue(module.__file__.endswith('.so'))
        self.assertFalse(list(Path('/app').rglob('*.py')))
        self.assertFalse(list(Path('/app').rglob('*.pyc')))

suite=unittest.TestSuite()
for case in flatten(unittest.TestLoader().loadTestsFromNames(MODULES)):
    if case.id() in SKIP:
        method=getattr(type(case),case._testMethodName)
        setattr(type(case),case._testMethodName,unittest.skip(SKIP[case.id()])(method))
    suite.addTest(case)
suite.addTests(unittest.TestLoader().loadTestsFromTestCase(NativeRuntimeChecks))
result=unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(not result.wasSuccessful())
