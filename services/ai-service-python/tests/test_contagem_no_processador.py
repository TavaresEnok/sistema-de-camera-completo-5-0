"""Contagem de passagem dentro do StreamProcessor (sem vídeo e sem modelo)."""
import unittest

from stream_processor import StreamProcessor

LINHA_CONTAGEM = {"id": "porta", "name": "Porta", "kind": "line", "points": [[0.5, 0.2], [0.5, 0.8]],
                  "uso": "contagem", "entrada": "ab"}
LINHA_ALERTA = {"id": "muro", "name": "Muro", "kind": "line", "points": [[0.1, 0.1], [0.9, 0.1]]}


def processador(zonas, **extra):
    info = {"detectionZones": zonas, **extra}
    return StreamProcessor("unit-camera", "rtsp://example.invalid/test", "http://example.invalid",
                           "unit-token", analysis_type="general", source_info=info)


class ContagemNoProcessador(unittest.TestCase):
    def test_sem_linha_de_contagem_nada_muda(self):
        p = processador([LINHA_ALERTA], countingFps=12)
        self.assertIsNone(p.counting_fps)
        self.assertIsNone(p.contador_de_passagem)
        self.assertIsNone(p.counting_state())
        p.adaptive_enabled = False
        p._apply_qos_mode("base")
        self.assertEqual(p.advanced_process_fps, p.base_advanced_process_fps)

    def test_taxa_da_contagem_vale_so_nesta_camera(self):
        p = processador([LINHA_CONTAGEM], countingFps=12)
        p.adaptive_enabled = False
        p._apply_qos_mode("base")
        self.assertEqual(p.counting_fps, 12)
        self.assertGreaterEqual(p.advanced_process_fps, 12)
        self.assertGreaterEqual(p.process_fps, 12)

    def test_taxa_invalida_ou_ausente_usa_padrao_8(self):
        self.assertEqual(processador([LINHA_CONTAGEM]).counting_fps, 8)
        self.assertEqual(processador([LINHA_CONTAGEM], countingFps=30).counting_fps, 8)

    def test_modo_adaptativo_nao_derruba_a_taxa_da_contagem(self):
        p = processador([LINHA_CONTAGEM], countingFps=8)
        p.adaptive_enabled = True
        for chave in p._adaptive_state:
            p._adaptive_state[chave]["fps_idx"] = 2
        p._apply_qos_mode("base")
        self.assertGreaterEqual(p.advanced_process_fps, 8)

    def test_somente_contagem_vem_da_api(self):
        p = processador([LINHA_CONTAGEM], objectDetection={"ativo": True, "somenteContagem": True, "classes": ["person"]})
        self.assertTrue(p.somente_contagem)
        self.assertFalse(processador([LINHA_CONTAGEM]).somente_contagem)

    def test_simulacao_nao_conta(self):
        p = processador([LINHA_CONTAGEM], simulationOnly=True)
        p.adaptive_enabled = False
        p._apply_qos_mode("grid")
        self.assertLess(p.advanced_process_fps, 8)

    def test_estado_exposto_na_saude(self):
        estado = processador([LINHA_CONTAGEM], countingFps=5).counting_state()
        self.assertEqual(estado["fps"], 5)
        self.assertEqual((estado["entries"], estado["exits"]), (0, 0))


if __name__ == "__main__":
    unittest.main()
