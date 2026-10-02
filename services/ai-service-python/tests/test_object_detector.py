"""Cobertura do detectors/object_detector.py (item D3).

O host NÃO tem cv2 nem a stack de ML (supervision/openvino) → estes testes são
PULADOS com @unittest.skipUnless. Rodam no container do runner ML
(services/ai-service-python/run-ml-tests.sh, imagem drac-ai-test-ml).

Estratégia: NÃO baixamos modelo nem openvino. A inferência real precisaria de um
runtime OpenVINO compilado; aqui INJETAMOS uma "infer_request" sintética que
devolve linhas [x1,y1,x2,y2,score,cls] no formato end2end que o modelo produz.
Assim exercitamos a LÓGICA REAL de pós-processamento do object_detector:
  - filtro por classe ativa
  - corte por confiança (por classe)
  - corte por altura mínima do objeto
  - descarte de bbox degenerada
  - mapeamento de rótulo/flags (vehicleProxy/riderVehicleProxy)
  - o tracking real (sv.ByteTrack) via _track_people / caminho persistent_track_id
  - a matemática de letterbox do _preprocess
  - resolução de caminho de modelo e escolha de precisão (lógica pura de string/fs)

Framework: unittest da stdlib (decisão 9.2).
"""

import os
import tempfile
import unittest
from unittest import mock
from queue import Queue

import numpy as np

try:
    import cv2  # noqa: F401
    import supervision  # noqa: F401
    from detectors.base import Detection
    from detectors.object_detector import (
        ObjectDetector,
        CLASS_LABELS,
        GENERAL_PROFILE,
        PERSON_CLASS_ID,
        BICYCLE_CLASS_ID,
        CAR_CLASS_ID,
        MOTORCYCLE_CLASS_ID,
        BUS_CLASS_ID,
        VEHICLE_CLASS_IDS,
        RIDER_VEHICLE_CLASS_IDS,
    )

    HAS_ML = True
except Exception:
    HAS_ML = False


class _FakeInferRequest:
    """Mímica mínima da infer_request do OpenVINO usada em ObjectDetector.infer."""

    def __init__(self, raw):
        self._raw = raw  # ndarray (1, N, 6)

    def infer(self, feed):  # o detector chama infer_request.infer({input: blob})
        return None

    def get_output_tensor(self, index):
        raw = self._raw

        class _Tensor:
            data = raw

        return _Tensor()


def _rows_to_raw(rows):
    """Empacota linhas [x1,y1,x2,y2,score,cls] no shape (1, N, 6) que o infer espera."""
    arr = np.asarray(rows, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[None, :]
    return arr[None, ...]


@unittest.skipUnless(HAS_ML, "requer cv2 + supervision (stack ML) — roda no container drac-ai-test-ml")
class TestObjectDetectorPostProcessing(unittest.TestCase):
    """infer() com saída sintética: filtro de classe/confiança/altura, sem modelo."""

    def setUp(self):
        # ─────────────────────────────────────────────────────────────────
        # O TESTE FIXA O PRÓPRIO PERFIL — não herda o do servidor.
        #
        # Estes dois testes quebraram em 21/08/2026 na instalação principal:
        # a licença de lá libera só "pessoa" (detect_vehicles=False), então o
        # filtro de licença cortava carro/moto/ônibus antes do funil, e a
        # associação de piloto (rider_association=True, piso 0,25) salvava a
        # pessoa de confiança 0,40 que o teste esperava ver descartada.
        #
        # O CÓDIGO estava certo nos dois casos. O defeito era o teste depender
        # da configuração de quem roda: passaria numa máquina e falharia na
        # outra, sem nada ter mudado no produto.
        # ─────────────────────────────────────────────────────────────────
        licenca_ampla = dict(GENERAL_PROFILE)
        licenca_ampla["detect_vehicles"] = True
        licenca_ampla["detect_objects"] = True
        patch = mock.patch.dict(
            "detectors.object_detector.GENERAL_PROFILE", licenca_ampla, clear=True
        )
        patch.start()
        self.addCleanup(patch.stop)

    def _detector_with_output(self, rows, input_size=640):
        det = ObjectDetector()
        # Piloto DESLIGADO por padrão: quem quiser testá-lo religa no próprio
        # teste. Ligado, ele promove pessoa abaixo do limiar e mascara o corte
        # por confiança que a maioria destes testes verifica.
        det._rider_config.enabled = False
        det.model = object()  # pula load() (não há modelo real)
        raw = _rows_to_raw(rows)

        pool = Queue(maxsize=1)
        pool.put(_FakeInferRequest(raw))
        runtime = {
            "model": None,
            "input": "input",
            "output": "output",
            "pool": pool,
            "path": "/fake/model.xml",
            "precision": "int8",
            "input_size": input_size,
        }
        det._runtime_for_hint = lambda hint=None: runtime
        return det

    def _frame(self, size=640):
        return np.zeros((size, size, 3), dtype=np.uint8)

    def _policy_rows(self):
        return [[20 + cls * 60, 20, 60 + cls * 60, 100, 0.95, cls]
                for cls in [PERSON_CLASS_ID, BICYCLE_CLASS_ID, CAR_CLASS_ID, MOTORCYCLE_CLASS_ID, BUS_CLASS_ID]]

    def test_current_plan_allows_vehicles_despite_disabled_legacy_flag(self):
        with mock.patch.dict(GENERAL_PROFILE, {"detect_vehicles": False}):
            det = self._detector_with_output(self._policy_rows())
            out = det.infer(self._frame(), allowed_classes={"person", "car", "motorcycle", "bicycle"})
        self.assertEqual({d.label for d in out}, {"pessoa", "carro", "moto", "bicicleta"})
        self.assertNotIn("onibus", {d.label for d in out})

    def test_person_only_plan_rejects_vehicles_even_when_legacy_flag_enabled(self):
        det = self._detector_with_output(self._policy_rows())
        out = det.infer(self._frame(), allowed_classes={"person"})
        self.assertEqual([d.label for d in out], ["pessoa"])

    def test_empty_plan_blocks_everything_without_running_model(self):
        det = self._detector_with_output(self._policy_rows())
        with mock.patch.object(det, "_detect_raw") as infer:
            self.assertEqual(det.infer(self._frame(), allowed_classes=set()), [])
            infer.assert_not_called()

    def test_unknown_policy_classes_cannot_enable_default_person(self):
        det = self._detector_with_output(self._policy_rows())
        self.assertEqual(det.infer(self._frame(), allowed_classes={"not-a-class"}), [])

    def test_legacy_callers_still_respect_vehicle_flag(self):
        with mock.patch.dict(GENERAL_PROFILE, {"detect_vehicles": False}):
            det = self._detector_with_output(self._policy_rows())
            self.assertEqual([d.label for d in det.infer(self._frame())], ["pessoa"])

    def test_policy_is_local_to_each_request_not_shared_detector_state(self):
        det = self._detector_with_output(self._policy_rows())
        original_ids = det.active_class_ids.copy()
        self.assertEqual([d.label for d in det.infer(self._frame(), allowed_classes={"car"})], ["carro"])
        self.assertEqual([d.label for d in det.infer(self._frame(), allowed_classes={"person"})], ["pessoa"])
        self.assertEqual(det.active_class_ids, original_ids)

    def test_policy_aliases_are_normalized_before_detector_filter(self):
        det = self._detector_with_output(self._policy_rows())
        self.assertEqual({d.label for d in det.infer(self._frame(), allowed_classes={"carro", "moto"})}, {"carro", "moto"})

    def test_cached_regions_cannot_leak_previously_allowed_class(self):
        det = self._detector_with_output(self._policy_rows())
        det._region_config = mock.Mock(enabled=True)
        cached = [Detection(label="carro", confidence=0.9, bbox=[20, 20, 60, 100], extra={"classId": CAR_CLASS_ID})]
        with mock.patch.object(det, "_infer_by_regions", return_value=cached) as infer:
            self.assertEqual(det.infer(self._frame(), motion_boxes=[], allowed_classes={"person"}), [])
            self.assertEqual(infer.call_args.args[-1], {PERSON_CLASS_ID})

    def test_tracking_coast_cannot_leak_revoked_vehicle(self):
        det = self._detector_with_output(self._policy_rows())
        coast = [Detection(label="carro", confidence=0.9, bbox=[20, 20, 60, 100], extra={"classId": CAR_CLASS_ID})]
        with mock.patch.dict(GENERAL_PROFILE, {"persistent_track_id": True}):
            with mock.patch.object(det, "_track_people", return_value=coast) as tracker:
                self.assertEqual(det.infer(self._frame(), context_key="camera", allowed_classes={"person"}), [])
                self.assertEqual([d.label for d in tracker.call_args.args[0]], ["pessoa"])

    def test_busy_worker_skips_preprocessing(self):
        det = self._detector_with_output([])
        runtime = det._runtime_for_hint()
        runtime['pool'].get_nowait()
        with mock.patch.object(det, '_preprocess') as preprocess:
            detections, ran = det._detect_raw(self._frame(), runtime)
        self.assertEqual(detections, [])
        self.assertFalse(ran)
        preprocess.assert_not_called()
        self.assertEqual(det._pool_busy_drops, 1)

    def test_preprocessing_failure_returns_worker_to_pool(self):
        det = self._detector_with_output([])
        runtime = det._runtime_for_hint()
        with mock.patch.object(det, '_preprocess', side_effect=ValueError('invalid frame')):
            with self.assertRaises(ValueError):
                det._detect_raw(self._frame(), runtime)
        self.assertEqual(runtime['pool'].qsize(), 1)

    def test_filtra_classe_fora_das_ativas(self):
        det = self._detector_with_output(
            [
                [10, 10, 100, 200, 0.9, PERSON_CLASS_ID],   # pessoa (ativa)
                [10, 10, 100, 200, 0.9, 7],                 # 7 = truck, NÃO ativa
            ]
        )
        det.active_class_ids = {PERSON_CLASS_ID}
        det.min_object_height = 1
        out = det.infer(self._frame(), context_key=None, input_size_hint=640)
        self.assertEqual([d.extra["classId"] for d in out], [PERSON_CLASS_ID])

    def test_corta_por_confianca_da_classe(self):
        det = self._detector_with_output(
            [
                [10, 10, 100, 200, 0.60, PERSON_CLASS_ID],  # acima do limiar
                [10, 10, 100, 200, 0.40, PERSON_CLASS_ID],  # abaixo do limiar
            ]
        )
        det.active_class_ids = {PERSON_CLASS_ID}
        det.class_confidence = {PERSON_CLASS_ID: 0.5}
        det.min_conf = 0.5
        det.min_object_height = 1
        out = det.infer(self._frame(), context_key=None, input_size_hint=640)
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(out[0].confidence, 0.60, places=4)

    def test_corta_por_altura_minima(self):
        det = self._detector_with_output(
            [
                [10, 10, 100, 30, 0.9, PERSON_CLASS_ID],    # altura 20
                [10, 10, 100, 200, 0.9, PERSON_CLASS_ID],   # altura 190
            ]
        )
        det.active_class_ids = {PERSON_CLASS_ID}
        det.min_object_height = 50
        out = det.infer(self._frame(), context_key=None, input_size_hint=640)
        self.assertEqual(len(out), 1)
        _, y1, _, y2 = out[0].bbox
        self.assertGreaterEqual(y2 - y1, 50)

    def test_descarta_bbox_degenerada(self):
        det = self._detector_with_output(
            [
                [100, 100, 100, 200, 0.9, PERSON_CLASS_ID],  # x2==x1 → largura 0
                [200, 200, 100, 100, 0.9, PERSON_CLASS_ID],  # x2<x1 e y2<y1
            ]
        )
        det.active_class_ids = {PERSON_CLASS_ID}
        det.min_object_height = 1
        out = det.infer(self._frame(), context_key=None, input_size_hint=640)
        self.assertEqual(out, [])

    def test_rotulos_e_flags_de_veiculo(self):
        det = self._detector_with_output(
            [
                [10, 10, 100, 200, 0.9, PERSON_CLASS_ID],
                [10, 10, 100, 200, 0.9, CAR_CLASS_ID],
                [10, 10, 100, 200, 0.9, MOTORCYCLE_CLASS_ID],
                [10, 10, 100, 200, 0.9, BUS_CLASS_ID],
            ]
        )
        det.active_class_ids = {PERSON_CLASS_ID, CAR_CLASS_ID, MOTORCYCLE_CLASS_ID, BUS_CLASS_ID}
        det.class_confidence = {c: 0.1 for c in det.active_class_ids}
        det.min_conf = 0.1
        det.vehicle_min_conf = 0.1
        det.min_object_height = 1
        out = {d.extra["classId"]: d for d in det.infer(self._frame(), context_key=None, input_size_hint=640)}

        self.assertEqual(out[PERSON_CLASS_ID].label, "pessoa")
        self.assertEqual(out[CAR_CLASS_ID].label, "carro")
        self.assertEqual(out[BUS_CLASS_ID].label, "onibus")
        self.assertEqual(out[MOTORCYCLE_CLASS_ID].label, "moto")

        self.assertFalse(out[PERSON_CLASS_ID].extra["vehicleProxy"])
        self.assertTrue(out[CAR_CLASS_ID].extra["vehicleProxy"])
        self.assertTrue(out[MOTORCYCLE_CLASS_ID].extra["riderVehicleProxy"])
        self.assertFalse(out[CAR_CLASS_ID].extra["riderVehicleProxy"])

    def test_pool_ocupado_dropa_o_frame(self):
        # Sem infer_request disponível (pool vazio) → descarta o frame e conta o drop.
        det = ObjectDetector()
        det.model = object()
        empty_pool = Queue(maxsize=1)  # vazio de propósito
        runtime = {"pool": empty_pool, "input": "in", "output": "out", "input_size": 640, "path": "x", "precision": "int8"}
        det._runtime_for_hint = lambda hint=None: runtime
        before = det._pool_busy_drops
        out = det.infer(self._frame(), context_key=None, input_size_hint=640)
        self.assertEqual(out, [])
        self.assertEqual(det._pool_busy_drops, before + 1)
        self.assertEqual(det._pool_busy_drops_by_size.get(640), 1)


@unittest.skipUnless(HAS_ML, "requer cv2 + supervision (stack ML)")
class TestObjectDetectorTracking(unittest.TestCase):
    """Tracking real com sv.ByteTrack sobre detecções sintéticas (item 2.5)."""

    def _person(self, bbox, conf=0.9):
        return Detection(
            label="pessoa",
            confidence=conf,
            bbox=list(bbox),
            extra={"classId": PERSON_CLASS_ID},
        )

    def _obj(self, cls, bbox, conf=0.9):
        return Detection(
            label=CLASS_LABELS.get(cls, "detected"),
            confidence=conf,
            bbox=list(bbox),
            extra={"classId": cls},
        )

    def test_track_people_atribui_id_estavel(self):
        det = ObjectDetector()
        det.active_class_ids = {PERSON_CLASS_ID}
        bbox = [100, 100, 160, 300]
        ids = []
        for _ in range(5):
            tracked = det._track_people([self._person(bbox)], context_key="camA")
            self.assertTrue(tracked, "cada frame com uma pessoa deve devolver ao menos 1 track")
            ids.append(tracked[0].extra["trackId"])
        self.assertEqual(len(set(ids)), 1, "o mesmo objeto parado deve manter o mesmo trackId")

    def test_track_id_codifica_a_classe(self):
        # Usa CARRO (classId=2, não-zero) para que o namespacing por classe no
        # trackId realmente conte — com pessoa (classId=0) a fórmula seria opaca.
        det = ObjectDetector()
        det.active_class_ids = {CAR_CLASS_ID}
        tracked = None
        for _ in range(3):
            tracked = det._track_people([self._obj(CAR_CLASS_ID, [100, 100, 220, 260])], context_key="camB")
        item = tracked[0]
        raw = item.extra["rawTrackId"]
        # trackId = classId * 100000 + rawTrackId  (namespacing por classe)
        self.assertEqual(item.extra["trackId"], CAR_CLASS_ID * 100000 + raw)
        self.assertNotEqual(item.extra["trackId"], raw)  # a classe DEVE deslocar o id
        self.assertEqual(item.extra["trackClassId"], CAR_CLASS_ID)
        self.assertTrue(item.extra["vehicleProxy"])
        self.assertEqual(item.label, "carro")

    def test_contextos_diferentes_nao_compartilham_tracker(self):
        det = ObjectDetector()
        det.active_class_ids = {PERSON_CLASS_ID}
        det._track_people([self._person([100, 100, 160, 300])], context_key="camA")
        # camB nunca viu nada antes → cria tracker próprio.
        det._track_people([self._person([100, 100, 160, 300])], context_key="camB")
        keys = set(det._trackers.keys())
        self.assertIn(f"camA:class:{PERSON_CLASS_ID}", keys)
        self.assertIn(f"camB:class:{PERSON_CLASS_ID}", keys)


@unittest.skipUnless(HAS_ML, "requer cv2 + supervision (stack ML)")
class TestObjectDetectorPureLogic(unittest.TestCase):
    """Lógica que não toca modelo: confiança por classe, letterbox, resolução de path."""

    def test_confidence_for_class(self):
        det = ObjectDetector()
        det.class_confidence = {PERSON_CLASS_ID: 0.31, CAR_CLASS_ID: 0.22}
        det.vehicle_min_conf = 0.19
        det.min_conf = 0.5
        self.assertAlmostEqual(det._confidence_for_class(PERSON_CLASS_ID), 0.31)
        self.assertAlmostEqual(det._confidence_for_class(CAR_CLASS_ID), 0.22)
        # bicicleta não está no dict, mas é veículo → cai no vehicle_min_conf
        det.class_confidence = {PERSON_CLASS_ID: 0.31}
        self.assertAlmostEqual(det._confidence_for_class(BICYCLE_CLASS_ID), 0.19)
        # classe totalmente desconhecida (99) → min_conf
        self.assertAlmostEqual(det._confidence_for_class(99), 0.5)

    def test_preprocess_letterbox(self):
        det = ObjectDetector()
        frame = np.zeros((480, 640, 3), dtype=np.uint8)  # h=480, w=640
        blob, scale, pad_x, pad_y, w, h, size = det._preprocess(frame, 640)
        self.assertEqual(blob.shape, (1, 3, 640, 640))
        self.assertEqual(blob.dtype, np.float32)
        self.assertEqual((w, h, size), (640, 480, 640))
        self.assertAlmostEqual(scale, 1.0, places=6)  # min(640/640, 640/480) = 1.0
        self.assertEqual(pad_x, 0)
        self.assertEqual(pad_y, (640 - 480) // 2)  # 80
        self.assertLessEqual(float(blob.max()), 1.0)
        self.assertGreaterEqual(float(blob.min()), 0.0)
        # o canto superior é padding (114) → 114/255 em todos os canais
        self.assertAlmostEqual(float(blob[0, 0, 0, 0]), 114.0 / 255.0, places=5)

    def test_candidate_model_dirs_ordena_por_precisao(self):
        det = ObjectDetector()
        det.model_name = "yolo26n"
        det.input_size = 640
        det.requested_precision = "int8"
        dirs_int8 = det._candidate_model_dirs(640)
        self.assertIn("int8", os.path.basename(dirs_int8[0]))
        det.requested_precision = "fp32"
        dirs_fp32 = det._candidate_model_dirs(640)
        self.assertIn("fp32", os.path.basename(dirs_fp32[0]))
        self.assertNotIn("int8", os.path.basename(dirs_fp32[0]))
        # sem candidatos duplicados
        self.assertEqual(len(dirs_int8), len(set(dirs_int8)))

    def test_resolve_model_xml_explicit_path(self):
        det = ObjectDetector()
        with tempfile.TemporaryDirectory() as tmp:
            xml = os.path.join(tmp, "yolo26n_int8.xml")
            with open(xml, "w", encoding="utf-8") as handle:
                handle.write("<net/>")
            det.explicit_model_path = xml
            path, precision = det._resolve_model_xml(640)
            self.assertEqual(path, xml)
            self.assertEqual(precision, "int8")  # "int8" no nome → precisão int8

    def test_resolve_model_xml_sem_modelo_erra(self):
        det = ObjectDetector()
        det.explicit_model_path = ""
        # /app/models não existe/está vazio no container de teste → RuntimeError
        with self.assertRaises(RuntimeError):
            det._resolve_model_xml(640)

    def test_status_expoe_campos_sem_modelo(self):
        det = ObjectDetector()
        status = det.status()
        for key in ("model", "requested_precision", "active_class_ids", "class_confidence", "pool_busy_drops"):
            self.assertIn(key, status)
        self.assertIsInstance(status["available_input_sizes"], list)


if __name__ == "__main__":
    unittest.main()
