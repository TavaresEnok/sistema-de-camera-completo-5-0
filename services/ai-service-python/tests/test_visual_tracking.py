"""Real ByteTrack/OpenCV plus synthetic frames; never claims physical recall."""
import copy
import time
import unittest
from unittest import mock
from queue import Queue

import numpy as np

try:
    import cv2
    import supervision
    from trackers.bytetrack_backend import ByteTrackBackend
    from trackers.visual_bridge import VisualTrackBridge, VisualBridgeConfig
    from detectors.native_roi import NativeRoiConfig, choose_native_roi, project_native_crop, merge_native_crop
    from detectors.base import Detection
    from detectors.object_detector import ObjectDetector, GENERAL_PROFILE
    from detectors.confirmacao_de_objeto import ConfirmadorDeObjeto, PoliticaDeConfirmacao
    from detectors.tripwire import DetectorDeTravessia
    HAS_ML = True
except ImportError:
    HAS_ML = False


def person(box=(80, 50, 140, 130), score=0.8, track=1, **extra):
    return Detection('pessoa', score, list(box), event_type='OBJECT_DETECTED',
                     extra={'classId':0, 'trackId':track, 'observedByModel':True, **extra})


def textured(dx=0, dy=0, width=320, height=180):
    frame = np.full((height, width, 3), 40, np.uint8)
    rng = np.random.default_rng(182)
    patch = rng.integers(40, 230, (80, 60, 3), dtype=np.uint8)
    frame[50+dy:130+dy, 80+dx:140+dx] = patch
    return frame


@unittest.skipUnless(HAS_ML, 'OpenCV + Supervision')
class ByteTrackImprovementTests(unittest.TestCase):
    def backend(self, cls=0, threshold=.3, **kwargs):
        return ByteTrackBackend(cls, threshold, 20, 4, recovery_grace_ms=2000, **kwargs)

    def update(self, backend, score=None, now=0, box=(80,50,140,130)):
        return backend.update(np.asarray([box], np.float32) if score is not None else np.zeros((0,4),np.float32),
                              np.asarray([score],np.float32) if score is not None else np.zeros(0,np.float32),
                              timestamp=now)

    def test_person_035_starts_after_empty_scene_without_confidence_inflation(self):
        b = self.backend()
        self.update(b, now=1)
        out = [self.update(b,.35,now=1.25+i*.25) for i in range(6)]
        self.assertTrue(out[-1])
        self.assertEqual({v[0].track_id for v in out if v}, {1})
        self.assertAlmostEqual(out[-1][0].confidence,.35,places=5)

    def test_car_025_can_confirm_without_turning_025_into_event_score(self):
        b = self.backend(2,.25)
        self.update(b,now=1)
        self.update(b,.25,now=1.25)
        out = self.update(b,.25,now=1.5)
        self.assertEqual(len(out),1)
        self.assertAlmostEqual(out[0].confidence,.25)

    def test_weak_alone_never_starts_an_id(self):
        b = self.backend()
        for i in range(8):
            self.assertEqual(self.update(b,.2,now=1+i*.25),[])

    def test_weak_observations_keep_existing_id(self):
        b = self.backend()
        original = self.update(b,.85,now=1)[0].track_id
        for i in range(6):
            out=self.update(b,.20,now=1.25+i*.25)
            self.assertEqual(out[0].track_id,original)
            self.assertAlmostEqual(out[0].confidence,.20,places=5)

    def test_buffer_is_seconds_not_fps_divided_by_30(self):
        b=self.backend()
        self.assertEqual(b.status()['max_lost_frames'],8)
        original=self.update(b,.85,now=1)[0].track_id
        for i in range(4):
            self.update(b,now=1.25+i*.25)
        self.assertEqual(self.update(b,.85,now=2.25)[0].track_id,original)

    def test_old_id_expires_by_wall_clock_without_id_recycling(self):
        b=self.backend()
        original=self.update(b,.85,now=1)[0].track_id
        self.update(b,now=1.25)
        self.update(b,.85,now=4)
        out=self.update(b,.85,now=4.25)
        self.assertTrue(out)
        self.assertNotEqual(out[0].track_id,original)

    def test_lost_track_expires_during_continuous_frames_without_missing_api(self):
        b=self.backend()
        self.update(b,.85,now=1)
        for i in range(1,18):
            self.update(b,now=1+i*.15)
        self.assertGreater(b.status()['expired_by_time'],0)

    def test_legacy_gate_still_reproduces_the_original_problem(self):
        b=self.backend(legacy_thresholds=True)
        self.update(b,now=1)
        for i in range(6):
            self.assertEqual(self.update(b,.35,now=1.25+i*.25),[])
        self.assertEqual(b.status()['max_lost_frames'],2)

    def test_resolution_change_preserves_identity(self):
        b=self.backend()
        original=self.update(b,.85,now=1)[0].track_id
        b.rescale_coordinates(.5,.5)
        out=self.update(b,.85,now=1.25,box=(40,25,70,65))
        self.assertEqual(out[0].track_id,original)


@unittest.skipUnless(HAS_ML, 'OpenCV + Supervision')
class VisualBridgeTests(unittest.TestCase):
    def seed(self):
        b=VisualTrackBridge(VisualBridgeConfig())
        for i in range(3):
            b.seed(textured(),[person()],1+i*.25)
        return b

    def test_tracks_pixels_without_new_model_evidence(self):
        b=self.seed()
        out=b.advance(textured(3,2),[(83,52,143,132)],1.75)
        self.assertIsNotNone(out)
        self.assertEqual(out[0].extra['trackId'],1)
        self.assertFalse(out[0].extra['observedByModel'])
        self.assertTrue(out[0].extra['estimated'])
        np.testing.assert_allclose(out[0].bbox,[83,52,143,132],atol=1)
        self.assertAlmostEqual(out[0].confidence,.8)

    def test_refresh_after_two_skips_is_mandatory(self):
        b=self.seed()
        self.assertIsNotNone(b.advance(textured(2),[(82,50,142,130)],1.75))
        self.assertIsNotNone(b.advance(textured(4),[(84,50,144,130)],2.00))
        self.assertIsNone(b.advance(textured(6),[(86,50,146,130)],2.25))

    def test_unconfirmed_track_cannot_skip_object_detector(self):
        b=VisualTrackBridge(VisualBridgeConfig())
        b.seed(textured(),[person()],1)
        self.assertIsNone(b.advance(textured(2),[],1.25))

    def test_new_motion_outside_box_forces_model(self):
        b=self.seed()
        self.assertIsNone(b.advance(textured(2),[(220,30,250,90)],1.75))
        self.assertEqual(b.status()['fallbacks']['new_motion'],1)

    def test_missing_motion_is_not_the_same_as_empty_motion(self):
        b=self.seed()
        self.assertIsNone(b.advance(textured(2),None,1.75))

    def test_no_texture_never_coasts_a_fake_box(self):
        b=VisualTrackBridge(VisualBridgeConfig())
        blank=np.zeros((180,320,3),np.uint8)
        for i in range(3):
            b.seed(blank,[person()],1+i*.25)
        self.assertIsNone(b.advance(blank,[],1.75))

    def test_object_disappearing_forces_model(self):
        b=self.seed()
        self.assertIsNone(b.advance(np.full((180,320,3),40,np.uint8),[],1.75))

    def test_resolution_change_and_gap_force_model(self):
        b=self.seed()
        self.assertIsNone(b.advance(np.zeros((360,640,3),np.uint8),[],1.75))
        self.assertIsNone(b.advance(textured(),[],2.1))

    def test_flow_does_not_increment_event_evidence(self):
        c=ConfirmadorDeObjeto(PoliticaDeConfirmacao(minimo_de_quadros=3))
        self.assertEqual(c.avaliar([person()]),[])
        estimated=person(observedByModel=False,estimated=True)
        for _ in range(30):
            self.assertEqual(c.avaliar([estimated]),[])
        self.assertEqual(c.avaliar([person()]),[])
        self.assertEqual(len(c.avaliar([person()])),1)

    def test_flow_without_track_id_cannot_bypass_confirmation(self):
        c=ConfirmadorDeObjeto()
        self.assertEqual(c.avaliar([person(track=None,observedByModel=False)]),[])

    def test_flow_cannot_trigger_tripwire(self):
        t=DetectorDeTravessia([{'id':'a','kind':'line','points':[[.5,0],[.5,1]],'sentido':'ambos'}])
        t.avaliar([person((10,20,50,60))],100,100,agora=1)
        self.assertEqual(t.avaliar([person((50,20,90,60),estimated=True,observedByModel=False)],100,100,agora=1.25),[])


@unittest.skipUnless(HAS_ML, 'OpenCV + Supervision')
class NativeCropTests(unittest.TestCase):
    def test_bridge_does_not_skip_weak_or_untracked_visible_objects(self):
        bridge = VisualTrackBridge(VisualBridgeConfig())
        weak = person(score=.2, track=2, associationOnly=True)
        for i in range(5):
            bridge.seed(textured(), [person(), weak], 1+i*.15)
        self.assertFalse(bridge.ready)
        self.assertIsNone(bridge.advance(textured(), [], 1.9))

    def test_unreported_new_pixel_motion_forces_model_even_with_empty_motion_boxes(self):
        bridge = VisualTrackBridge(VisualBridgeConfig())
        for i in range(4): bridge.seed(textured(), [person()], 1+i*.15)
        frame=textured(); frame[30:45,220:245]=200
        self.assertIsNone(bridge.advance(frame, [], 1.6))
        self.assertEqual(bridge.stats['fallbacks']['uncovered_pixel_change'],1)

    def test_crop_is_bounded_and_does_not_replace_whole_coverage(self):
        r=choose_native_roi((1080,1920),[(1500,500,1530,540)],NativeRoiConfig())
        self.assertIsNotNone(r)
        self.assertLessEqual(r[2]-r[0],512)
        self.assertLessEqual(r[3]-r[1],512)
        self.assertLessEqual(r[0],1500)
        self.assertGreaterEqual(r[2],1530)

    def test_projection_returns_advanced_coordinates_not_native(self):
        d=person((20,30,60,100))
        r=(1000,500,1224,724)
        out=project_native_crop([d],r,(1080,1920),(540,960))
        self.assertEqual(out[0].bbox,[510,265,530,300])
        self.assertEqual(d.bbox,[20,30,60,100])

    def test_cut_edges_and_low_crop_confidence_rejected(self):
        out=project_native_crop([person((0,30,60,100)),person((20,30,60,100),score=.35)],
                                (1000,500,1224,724),(1080,1920),(540,960))
        self.assertEqual(out,[])

    def test_merge_does_not_merge_different_classes_or_whole_boxes(self):
        a,b=person(),person()
        self.assertEqual(len(merge_native_crop([a,b],[])),2)
        car=person(classId=2)
        self.assertEqual(len(merge_native_crop([a],[car])),2)
        self.assertEqual(len(merge_native_crop([a],[copy.deepcopy(a)])),1)


@unittest.skipUnless(HAS_ML, 'OpenCV + Supervision')
class TemporalIntegrationTests(unittest.TestCase):
    def setUp(self):
        patch=mock.patch.dict(GENERAL_PROFILE,{'persistent_track_id':True,'native_roi':False,'visual_tracking':True,
                                              'tracker':'bytetrack','tracker_low_association':True})
        patch.start()
        self.addCleanup(patch.stop)

    def test_busy_pool_does_not_age_tracker_or_seed_estimates(self):
        d=ObjectDetector()
        d.model=object()
        runtime={'input_size':640,'pool':Queue()}
        d._runtime_for_hint=lambda hint:runtime
        with mock.patch.object(d,'_track_people') as tracker:
            self.assertEqual(d.infer(textured(),context_key='a',allowed_classes={'person'},motion_boxes=[],timestamp=1),[])
            tracker.assert_not_called()
        self.assertEqual(d.temporal_status()['per_camera']['a']['model_frames'],0)

    def test_global_budget_blocks_before_preprocessing_and_returns_on_error(self):
        d=ObjectDetector()
        for _ in range(d._global_request_limit):
            self.assertTrue(d._global_requests.acquire(False))
        runtime={'input_size':640,'pool':Queue()}
        with mock.patch.object(d,'_preprocess') as preprocess:
            self.assertEqual(d._detect_raw(textured(),runtime),([],False))
            preprocess.assert_not_called()
        for _ in range(d._global_request_limit):
            d._global_requests.release()
        runtime['pool'].put(object())
        with mock.patch.object(d,'_preprocess',side_effect=ValueError('synthetic')):
            with self.assertRaises(ValueError):
                d._detect_raw(textured(),runtime)
        self.assertEqual(runtime['pool'].qsize(),1)
        self.assertTrue(d._global_requests.acquire(False))

    def test_revoked_plan_discards_bridge_and_context(self):
        d=ObjectDetector()
        state=d._context_for('a')
        for i in range(3):
            state['bridge'].seed(textured(),[person()],1+i*.25)
        self.assertEqual(d.infer(textured(),context_key='a',allowed_classes=set(),timestamp=1.75),[])
        self.assertNotIn('a',d._contexts)

    def test_explicit_release_reclaims_per_camera_state(self):
        d=ObjectDetector()
        d._context_for('a')
        d._track_people([person()], 'a', timestamp=1)
        d.release_context('a')
        self.assertNotIn('a',d._contexts)
        self.assertFalse(any(k.startswith('a:class:') for k in d._trackers))

    def detector(self):
        d=ObjectDetector()
        d.model=object()
        d._runtime_for_hint=lambda hint:{'input_size':640}
        return d

    def test_temporal_mode_reduces_real_calls_without_changing_id(self):
        d=self.detector()
        current=[None]
        def raw(frame, runtime, **kwargs):
            return [person(current[0])],True
        with mock.patch.object(d,'_detect_raw',side_effect=raw) as raw_call:
            outputs=[]
            for i in range(40):
                dx=i*2
                current[0]=(80+dx,50,140+dx,130)
                result=d.infer(textured(dx),context_key='a',allowed_classes={'person'},
                               motion_boxes=[current[0]],timestamp=1+i*.25)
                outputs.append(result)
            self.assertLessEqual(raw_call.call_count,16)
        self.assertEqual({o[0].extra['trackId'] for o in outputs if o},{1})
        self.assertTrue(any(o.execution_kind=='visual' for o in outputs))
        self.assertTrue(all(o.model_calls==0 for o in outputs if o.execution_kind=='visual'))

    def test_shape_change_reprojects_tracker_and_forces_real_model(self):
        d=self.detector()
        current=[(80,50,140,130)]
        def raw(frame,runtime,**kwargs):
            return [person(current[0])],True
        with mock.patch.object(d,'_detect_raw',side_effect=raw):
            first=d.infer(textured(),context_key='a',allowed_classes={'person'},motion_boxes=[],timestamp=1)
            current[0]=(40,25,70,65)
            half=cv2.resize(textured(),(160,90))
            second=d.infer(half,context_key='a',allowed_classes={'person'},motion_boxes=[],timestamp=1.25)
        self.assertEqual(first[0].extra['trackId'],second[0].extra['trackId'])
        self.assertEqual(second.execution_kind,'model')

    def test_low_candidate_reaches_existing_tracker_but_not_new_id(self):
        d=self.detector()
        strong=person(score=.85)
        weak=person(score=.20,belowThreshold=True,associationOnly=True)
        self.assertTrue(d._track_people([strong],'a',timestamp=1))
        result=d._track_people([weak],'a',timestamp=1.25)
        self.assertTrue(result)
        self.assertAlmostEqual(result[0].confidence,.2)
        self.assertEqual(d._track_people([weak],'b',timestamp=1),[])

    def test_optional_roi_failure_keeps_whole_result(self):
        with mock.patch.dict(GENERAL_PROFILE,{'native_roi':True}):
            d=self.detector()
        d._available_input_sizes=lambda:[640,512]
        with mock.patch.object(d,'_detect_raw',return_value=([person()],True)), \
                mock.patch.object(d,'_ensure_runtime',side_effect=RuntimeError('synthetic unavailable variant')):
            for i in range(3):
                out=d.infer(textured(),context_key='a',allowed_classes={'person'},
                            native_frame=np.zeros((1080,1920,3),np.uint8),
                            native_motion_boxes=[(1400,500,1440,560)],timestamp=1+i*.25)
        self.assertTrue(out)
        self.assertEqual(d._native_roi_errors,1)
        self.assertEqual(out.model_calls,1)

    def test_crop_and_model_never_mix_native_coordinate_units(self):
        with mock.patch.dict(GENERAL_PROFILE,{'native_roi':True}):
            d=self.detector()
        d._available_input_sizes=lambda:[640,512]
        d._ensure_runtime=lambda size:{'input_size':size}
        boxes=[]
        def raw(frame,runtime,**kwargs):
            boxes.append(frame.shape[:2])
            return ([person((20,30,60,100))] if runtime['input_size']==512 else [person()]),True
        with mock.patch.object(d,'_detect_raw',side_effect=raw), mock.patch.object(d,'_track_people',side_effect=lambda ds,*a,**kw:ds):
            for i in range(3):
                out=d.infer(textured(),context_key='a',allowed_classes={'person'},
                            native_frame=np.zeros((1080,1920,3),np.uint8),
                            native_motion_boxes=[(1400,500,1440,560)],timestamp=1+i*.25)
        self.assertEqual(out.model_calls,2)
        self.assertEqual(len(boxes),4)
        crop=[v for v in out if 'nativeRegion' in v.extra]
        self.assertEqual(len(crop),1)
        self.assertLessEqual(crop[0].bbox[2],320)
        self.assertLessEqual(crop[0].bbox[3],180)

    def test_old_processor_cannot_delete_new_processors_tracking(self):
        d=self.detector()
        with mock.patch.object(d,'_detect_raw',return_value=([person()],True)):
            d.infer(textured(),context_key='a',allowed_classes={'person'},timestamp=1,context_owner=101)
            d.infer(textured(),context_key='a',allowed_classes={'person'},timestamp=1.25,context_owner=202)
        d.release_context('a',101)
        self.assertIn('a',d._contexts)
        d.release_context('a',202)
        self.assertNotIn('a',d._contexts)

    def test_pending_alert_keeps_full_rate_of_real_model_observations(self):
        d=self.detector()
        with mock.patch.object(d,'_detect_raw',return_value=([person()],True)) as raw:
            for i in range(8):
                out=d.infer(textured(),context_key='a',allowed_classes={'person'},motion_boxes=[],
                            timestamp=1+i*.25,confirmed_track_ids=set())
                self.assertEqual(out.execution_kind,'model')
            self.assertEqual(raw.call_count,8)
            out=d.infer(textured(),context_key='a',allowed_classes={'person'},motion_boxes=[],
                        timestamp=3,confirmed_track_ids={1})
            self.assertEqual(out.execution_kind,'visual')

    def test_visual_exception_does_not_blind_real_detector(self):
        d=self.detector()
        state=d._context_for('a')
        with mock.patch.object(state['bridge'],'advance',side_effect=RuntimeError('synthetic flow error')), \
                mock.patch.object(d,'_detect_raw',return_value=([person()],True)) as raw:
            result=d.infer(textured(),context_key='a',allowed_classes={'person'},motion_boxes=[],timestamp=1)
        self.assertEqual(raw.call_count,1)
        self.assertTrue(result)
        self.assertEqual(result.execution_kind,'model')


if __name__ == '__main__':
    unittest.main()
