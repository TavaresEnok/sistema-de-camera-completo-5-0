import unittest

from detectors.base import Detection
from object_policy import eh_objeto_para_confirmar, filtrar_deteccoes_por_classe, politica_de_objeto


class ObjectPolicyTest(unittest.TestCase):
    def test_permite_quarenta_por_cento(self):
        politica = politica_de_objeto({"objectDetection": {"classes": ["person"], "confirmThreshold": 0.4}})
        self.assertEqual(politica["confirm_threshold"], 0.4)
        politica = politica_de_objeto({"objectDetection": {"classes": ["person"], "confirmThreshold": 0.1}})
        self.assertEqual(politica["confirm_threshold"], 0.4)
    def test_normaliza_limites_e_classes(self):
        politica = politica_de_objeto({"objectDetection": {
            "classes": ["person", "CAR"],
            "confirmThreshold": 2,
            "confirmMinFrames": 99,
        }})
        self.assertEqual(politica["classes"], {"person", "car"})
        self.assertEqual(politica["confirm_threshold"], 0.90)
        self.assertEqual(politica["confirm_min_frames"], 6)

    def test_filtra_rotulos_portugueses_pela_configuracao_inglesa(self):
        itens = [
            Detection("pessoa", .8, [0, 0, 1, 1]),
            Detection("carro", .8, [0, 0, 1, 1]),
            Detection("moto", .8, [0, 0, 1, 1]),
        ]
        self.assertEqual(
            [d.label for d in filtrar_deteccoes_por_classe(itens, {"person", "motorcycle"})],
            ["pessoa", "moto"],
        )
        self.assertEqual(filtrar_deteccoes_por_classe(itens, set()), [])

    def test_objeto_realmente_passa_pela_confirmacao(self):
        self.assertTrue(eh_objeto_para_confirmar(Detection("pessoa", .8, [], event_type="OBJECT_DETECTED")))
        self.assertTrue(eh_objeto_para_confirmar(Detection("pessoa", .8, [], event_type=None)))
        self.assertFalse(eh_objeto_para_confirmar(Detection("movimento", 1, [], event_type="MOTION_DETECTED")))


if __name__ == "__main__":
    unittest.main()
