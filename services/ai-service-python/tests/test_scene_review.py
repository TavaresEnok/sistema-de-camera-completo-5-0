import unittest
from unittest.mock import patch
import numpy as np
from detectors.base import Detection
from scene_review import PersonBoxReview, corroborated, normalized_box


class Detector:
    def __init__(self):
        self.ran = True
        self.mirrored = []
        self.calls = 0

    def _runtime_for_hint(self, hint):
        return hint

    def _detect_raw(self, image, runtime, allowed_class_ids):
        self.calls += 1
        return self.mirrored, self.ran


class SceneReviewTests(unittest.TestCase):
    def setUp(self):
        self.cam = PersonBoxReview()
        self.det = Detector()
        self.frame = np.zeros((540,792,3), np.uint8)
        self.historical = [0,76,763,531]
        self.patterns = [normalized_box(self.historical,792,540)]
        self.clock = 50
        for target, effect in [('calibrations.for_camera',lambda *_: self.patterns),
                               ('reserve_check',lambda *_: True), ('time.monotonic',lambda: self.clock)]:
            p = patch('scene_review.'+target, side_effect=effect)
            p.start()
            self.addCleanup(p.stop)

    def run_frame(self,box=None,score=.45, label='pessoa'):
        self.clock += 1
        obj = Detection(label,score,self.historical if box is None else box,extra={'trackId':4})
        return self.cam.apply([obj], self.frame,self.det,416,'test','','','model')

    def test_dois_erros_independentes_antes_de_filtrar(self):
        self.assertTrue(self.run_frame())
        self.assertFalse(self.run_frame())
        self.assertEqual(self.det.calls,2)
        self.assertTrue(self.run_frame(score=.91))

    def test_sem_calibracao_preserva_e_marca(self):
        self.patterns = []
        self.run_frame()
        self.assertEqual(self.run_frame()[0].extra['sceneReview'],'unconfirmed')

    def test_cena_muda_ou_regra_removida_libera_imediatamente(self):
        self.run_frame()
        self.assertFalse(self.run_frame())
        self.patterns = []
        self.assertTrue(self.run_frame())
        self.patterns = [normalized_box(self.historical,792,540)]
        self.frame.fill(100)
        self.assertTrue(self.run_frame())

    def test_contraprovada_ou_sem_worker_preserva(self):
        self.det.mirrored = [Detection('pessoa',.48,[31,76,792,531])]
        self.assertTrue(self.run_frame())
        self.assertTrue(self.run_frame())
        self.det.ran=False
        self.clock+=5
        self.assertTrue(self.run_frame())

    def test_coordenadas_e_outras_classes(self):
        self.assertFalse(self.run_frame([799,0,860,500]))
        self.assertEqual(self.run_frame([-5,5,120,120])[0].bbox,[0,5,120,120])
        self.assertTrue(self.run_frame(label='carro'))
        self.assertEqual(self.det.calls,0)

    def test_posicao_espelhada(self):
        box=(.05,.1,.3,.9)
        self.assertTrue(corroborated(box,[Detection('person',.7,[70,10,95,90])],100,100))
        self.assertFalse(corroborated(box,[Detection('person',.7,[5,10,30,90])],100,100))
