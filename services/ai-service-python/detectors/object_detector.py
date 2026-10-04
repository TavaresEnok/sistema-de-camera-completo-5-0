import os
import threading
import time
import math
from queue import Empty, Queue

import cv2
import numpy as np
import supervision as sv

from .base import Detection, Detector
from .region_proposal import MotionRegionPlanner, RegionConfig
from .native_roi import NativeRoiConfig, choose_native_roi, project_native_crop, merge_native_crop
from onnxruntime_session import inference_threading_status
from runtime_profiles import GENERAL_PROFILE
from object_policy import filtrar_deteccoes_por_classe, normalizar_classe
from detectors.escolha_de_modelo import TETO_DE_CPU_PADRAO, escolher_modelo
from trackers import TrackerBackend, create_tracker, tracker_names
from trackers.camera_motion import GlobalMotionEstimator
from trackers.rider_association import RiderAssociator, RiderConfig
from trackers.visual_bridge import VisualBridgeConfig, VisualTrackBridge


PERSON_CLASS_ID = 0
BICYCLE_CLASS_ID = 1
CAR_CLASS_ID = 2
MOTORCYCLE_CLASS_ID = 3
BUS_CLASS_ID = 5
RIDER_VEHICLE_CLASS_IDS = {BICYCLE_CLASS_ID, MOTORCYCLE_CLASS_ID}
VEHICLE_CLASS_IDS = {BICYCLE_CLASS_ID, CAR_CLASS_ID, MOTORCYCLE_CLASS_ID, BUS_CLASS_ID}
def _gpu_realmente_presente() -> bool:
    """A GPU NVIDIA está de fato acessível a este container?

    Checa o DEVICE NODE, não a lista de providers do onnxruntime (que mente:
    lista CUDA sempre que os libs existem, mesmo sem placa). É uma checagem de
    sistema de arquivos — NUNCA quebra. Pedir CUDA sem placa segfalta o
    onnxruntime; esta função é o que impede isso.
    """
    # O DEVICE NODE decide, não a variável de ambiente. O toolkit da NVIDIA
    # endurecido (v1.17+, correção de CVE) troca NVIDIA_VISIBLE_DEVICES por
    # 'void' na criação de contêiner não-privilegiado MESMO quando entrega os
    # dispositivos — vetar por ela era falso negativo: placa presente, CUDA
    # recusado, tudo caindo para CPU. Diagnóstico de 14/08/2026: env 'void',
    # /dev/nvidia0 existindo, e o serviço a 4 núcleos de CPU com a RTX parada.
    # Sem placa não há device node, e a proteção original (nunca pedir CUDA
    # sem GPU, que segfalta o onnxruntime) continua valendo por inteiro.
    return os.path.exists("/dev/nvidia0") or os.path.exists("/dev/nvidiactl")


def classe_liberada(cls: int, allowed_class_ids: set[int] | None = None) -> bool:
    """A licença deste cliente permite MOSTRAR esta classe?

    Escrito em 14/08/2026, depois de o dono ver quadrado em CARRO com a Central
    liberando só "pessoa". As chaves GENERAL_DETECT_* existiam no perfil e NADA
    as consumia — o publicador emitia toda classe que o modelo enxerga, e a
    licença virava enfeite. Preservado ao mesclar o pacote de tracking, que não
    o continha.
    """
    # The API's per-camera plan is authoritative when supplied. Legacy process
    # flags cannot veto a vehicle explicitly enabled by the current plan.
    # None preserves old standalone callers; an empty set denies every class.
    if allowed_class_ids is not None:
        return cls in allowed_class_ids
    if cls == PERSON_CLASS_ID:
        return True
    if cls in VEHICLE_CLASS_IDS:
        return bool(GENERAL_PROFILE.get("detect_vehicles"))
    return bool(GENERAL_PROFILE.get("detect_objects"))


CLASS_LABELS = {
    PERSON_CLASS_ID: "pessoa",
    BICYCLE_CLASS_ID: "bicicleta",
    CAR_CLASS_ID: "carro",
    MOTORCYCLE_CLASS_ID: "moto",
    BUS_CLASS_ID: "onibus",
}
CLASS_IDS_BY_NAME = {normalizar_classe(label): cls for cls, label in CLASS_LABELS.items()}


class ObjectInference(list):
    """List-compatible result with unambiguous per-call execution metrics."""
    def __init__(self, values=(), execution_kind="model", model_calls=1):
        super().__init__(values)
        self.execution_kind = execution_kind
        self.model_calls = model_calls


class ObjectDetector(Detector):
    event_type = "OBJECT_DETECTED"

    def __init__(self, region_config: RegionConfig | None = None):
        self.input_size = int(GENERAL_PROFILE["imgsz"])
        # O MODELO SE AJUSTA À MÁQUINA. Sem placa, modelo grande não entra: em
        # 15/08/2026 a RTX foi movida e o `yolo26l` continuou no ambiente —
        # 38,7 ms por inferência NA PLACA foi parar no processador. Nada
        # quebrou (o portão de CUDA cai para CPU), mas ficou lento demais para
        # servir, em silêncio. Preservado ao mesclar o pacote de tracking.
        _pedido = str(GENERAL_PROFILE.get("model", "yolo26n")).strip().lower()
        _teto = str(GENERAL_PROFILE.get("cpu_model_ceiling", TETO_DE_CPU_PADRAO)).strip().lower()
        self.model_name, _motivo_rebaixamento = escolher_modelo(
            _pedido, tem_gpu=_gpu_realmente_presente(), teto_de_cpu=_teto,
        )
        if _motivo_rebaixamento:
            print(f"[ObjectDetector] MODELO REBAIXADO: {_motivo_rebaixamento}")
        self.requested_precision = str(GENERAL_PROFILE.get("precision", "fp32")).strip().lower()
        self.min_conf = float(GENERAL_PROFILE["confidence_person"])
        self.class_confidence = {
            PERSON_CLASS_ID: float(GENERAL_PROFILE.get("confidence_person", self.min_conf)),
            BICYCLE_CLASS_ID: float(GENERAL_PROFILE.get("confidence_bicycle", GENERAL_PROFILE.get("confidence_vehicle", self.min_conf))),
            CAR_CLASS_ID: float(GENERAL_PROFILE.get("confidence_car", GENERAL_PROFILE.get("confidence_vehicle", self.min_conf))),
            MOTORCYCLE_CLASS_ID: float(GENERAL_PROFILE.get("confidence_motorcycle", GENERAL_PROFILE.get("confidence_vehicle", self.min_conf))),
            BUS_CLASS_ID: float(GENERAL_PROFILE.get("confidence_bus", GENERAL_PROFILE.get("confidence_vehicle", self.min_conf))),
        }
        self.rider_vehicle_min_conf = float(GENERAL_PROFILE.get("confidence_rider_vehicle", self.min_conf))
        self.vehicle_min_conf = float(GENERAL_PROFILE.get("confidence_vehicle", self.rider_vehicle_min_conf))
        self.active_class_ids = {int(value) for value in GENERAL_PROFILE.get("class_ids", (PERSON_CLASS_ID,))}
        self.min_object_height = int(GENERAL_PROFILE["min_object_height_px"])
        self.track_buffer = int(GENERAL_PROFILE["track_buffer"])
        threading_plan = inference_threading_status()
        self.inference_threads = int(threading_plan["threads_per_worker"])
        self.inference_workers = int(threading_plan["effective_workers"])
        self.model = None
        self.loaded_model_path = ""
        self.loaded_precision = "fp32"
        self.explicit_model_path = str(GENERAL_PROFILE.get("model_path", "") or "").strip()
        self.openvino_device = str(GENERAL_PROFILE.get("openvino_device", "CPU") or "CPU").strip() or "CPU"
        self.openvino_performance_hint = str(GENERAL_PROFILE.get("openvino_performance_hint", "LATENCY") or "LATENCY").strip() or "LATENCY"
        self._runtime_lock = threading.Lock()
        self._runtimes: dict[int, dict] = {}
        self._global_request_limit = max(1, min(8, int(GENERAL_PROFILE.get("global_infer_requests", 2))))
        self._global_requests = threading.BoundedSemaphore(self._global_request_limit)
        self._global_busy_drops = 0
        self._real_infer_runs = 0
        self._infer_ms = 0.0
        self._low_association = bool(GENERAL_PROFILE.get("tracker_low_association", True))
        self._visual_config = VisualBridgeConfig(
            enabled=bool(GENERAL_PROFILE.get("visual_tracking", True)),
            refresh_seconds=max(0.25, min(2.0, float(GENERAL_PROFILE.get("visual_refresh_seconds", 0.75)))),
            max_skips=max(0, min(4, int(GENERAL_PROFILE.get("visual_max_skips", 2)))),
        )
        self._native_config = NativeRoiConfig(
            enabled=bool(GENERAL_PROFILE.get("native_roi", True)),
            every_model_frames=max(3, int(GENERAL_PROFILE.get("native_roi_every", 3))),
            confidence_floor=max(0.30, min(0.90, float(GENERAL_PROFILE.get("native_roi_confidence", 0.40)))),
        )
        self._context_lock = threading.Lock()
        self._contexts = {}
        self._native_roi_runs = 0
        self._native_roi_errors = 0
        self._tracker_lock = threading.Lock()
        # GENERAL_TRACKER agora falha ALTO se inválido — antes era lido e
        # ignorado silenciosamente (sv.ByteTrack hardcoded).
        self.tracker_name = str(GENERAL_PROFILE.get("tracker", "bytetrack")).strip().lower()
        if self.tracker_name not in tracker_names():
            raise ValueError(
                f"GENERAL_TRACKER='{self.tracker_name}' inválido. "
                f"Opções: {', '.join(tracker_names())}"
            )
        self._trackers: dict[str, TrackerBackend] = {}
        # Associação de piloto (uma máquina de estado por câmera)
        self._rider_config = RiderConfig(
            enabled=bool(GENERAL_PROFILE.get("rider_association", False)),
            person_floor=float(GENERAL_PROFILE.get("rider_person_floor", 0.12)),
            vehicle_min=float(GENERAL_PROFILE.get("rider_vehicle_min", 0.45)),
            confirm_frames=int(GENERAL_PROFILE.get("rider_confirm_frames", 2)),
        )
        self._rider_lock = threading.Lock()
        self._riders: dict[str, RiderAssociator] = {}
        # Compensação de movimento global (PTZ/vibração) — um estimador por câmera
        self._motion_comp_enabled = bool(GENERAL_PROFILE.get("camera_motion_comp", False))
        self._motion_estimators: dict[str, GlobalMotionEstimator] = {}
        # Funil detector→tracker por classe (responde "YOLO não viu" vs
        # "filtro derrubou" vs "tracker perdeu" — o caso 4 perto × 145 longe)
        self._pipeline_debug = bool(GENERAL_PROFILE.get("pipeline_debug", False))
        self._pipeline_stats: dict[int, dict[str, int]] = {}
        self._pool_busy_drops = 0
        self._pool_busy_drops_by_size: dict[int, int] = {}
        self._last_selected_size = self.input_size
        # DETECÇÃO POR REGIÃO (derivada do movimento) — PADRÃO DESLIGADO.
        # Com `enabled=False` nada muda: a inferência continua no frame inteiro,
        # mesmo que o chamador passe motion_boxes. Ver detectors/region_proposal.py.
        self._region_config = region_config if region_config is not None else RegionConfig.from_env()
        self._region_planners: dict[str, MotionRegionPlanner] = {}
        self._region_planner_locks: dict[str, threading.Lock] = {}
        self._region_registry_lock = threading.Lock()
        self._region_runs = 0
        self._region_crops = 0
        self._region_stationary_skips = 0
        self._region_sweeps = 0
        self._region_idle_full_frames = 0

    def _candidate_model_dirs(self, input_size: int) -> list[str]:
        base_dir = "/app/models"
        fp32_names = [
            f"{self.model_name}_fp32_{input_size}_openvino_model",
            f"{self.model_name}_openvino_model",
            f"{self.model_name}_fp32_openvino_model",
            f"{self.model_name}_openvino_fp32_model",
        ]
        int8_names = [
            f"{self.model_name}_int8_{input_size}_openvino_model",
            f"{self.model_name}_int8_openvino_model",
            f"{self.model_name}_openvino_int8_model",
            f"{self.model_name}_openvino_model_int8",
        ]
        if input_size != self.input_size:
            fp32_names = fp32_names[:1]
            int8_names = int8_names[:1]
        ordered_names = int8_names + fp32_names if self.requested_precision == "int8" else fp32_names + int8_names
        unique_names: list[str] = []
        for name in ordered_names:
            if name not in unique_names:
                unique_names.append(name)
        return [os.path.join(base_dir, name) for name in unique_names]

    def _resolve_model_xml(self, input_size: int) -> tuple[str, str]:
        searched: list[str] = []
        if self.explicit_model_path and input_size == self.input_size:
            searched.append(self.explicit_model_path)
            if os.path.isfile(self.explicit_model_path) and self.explicit_model_path.endswith(".xml"):
                precision = "int8" if "int8" in self.explicit_model_path.lower() else "fp32"
                return self.explicit_model_path, precision
        for candidate in self._candidate_model_dirs(input_size):
            searched.append(candidate)
            if not os.path.exists(candidate):
                continue
            if os.path.isfile(candidate) and candidate.endswith(".xml"):
                precision = "int8" if "int8" in os.path.basename(candidate).lower() else "fp32"
                return candidate, precision
            if os.path.isdir(candidate):
                xml_files = sorted([p for p in os.listdir(candidate) if p.endswith(".xml")])
                if not xml_files:
                    continue
                model_xml = os.path.join(candidate, xml_files[0])
                precision = "int8" if "int8" in os.path.basename(candidate).lower() else "fp32"
                return model_xml, precision
        joined = ", ".join(searched)
        raise RuntimeError(f"Modelo OpenVINO {input_size}px não encontrado. Diretórios testados: {joined}")

    def _compile_runtime(self, input_size: int) -> dict:
        try:
            import openvino as ov
        except Exception as exc:
            raise RuntimeError("Dependência openvino ausente para ObjectDetector.") from exc
        model_xml, loaded_precision = self._resolve_model_xml(input_size)
        core = ov.Core()
        model = core.read_model(model_xml)
        properties = {
            "PERFORMANCE_HINT": self.openvino_performance_hint,
            "NUM_STREAMS": str(max(1, min(self.inference_workers, int(GENERAL_PROFILE.get("openvino_streams", 1))))),
            "INFERENCE_NUM_THREADS": self.inference_threads,
        }
        fallback = None
        try:
            compiled_model = core.compile_model(model, self.openvino_device, properties)
        except Exception as exc:
            fallback = f"{type(exc).__name__}: {str(exc)[:300]}"
            print(f"[ObjectDetector] OpenVINO properties rejected; explicit fallback: {fallback}")
            compiled_model = core.compile_model(model, self.openvino_device)
        actual = {}
        for key in ("INFERENCE_NUM_THREADS", "NUM_STREAMS", "PERFORMANCE_HINT", "EXECUTION_DEVICES"):
            try:
                value = compiled_model.get_property(key)
                actual[key] = value if isinstance(value, (int, float, str, list)) else str(value)
            except Exception:
                actual[key] = None
        convolutions, int8_convolutions = 0, 0
        try:
            for node in compiled_model.get_runtime_model().get_ops():
                info = node.get_rt_info()
                if "layerType" in info and "convolution" in str(info["layerType"].value).lower():
                    convolutions += 1
                    if "runtimePrecision" in info and str(info["runtimePrecision"].value).upper() in {"I8", "U8", "INT8"}:
                        int8_convolutions += 1
        except Exception:
            pass
        worker_count = min(self._global_request_limit, max(1, int(actual.get("NUM_STREAMS") or properties["NUM_STREAMS"])))
        pool = Queue(maxsize=worker_count)
        for _ in range(worker_count):
            pool.put(compiled_model.create_infer_request())
        print(
            f"[ObjectDetector] Carregado model='{model_xml}' input_size={input_size} requested_precision='{self.requested_precision}' "
            f"active_precision='{loaded_precision}' classes='{GENERAL_PROFILE.get('classes')}' "
            f"requested_threads={self.inference_threads} actual={actual} infer_workers={worker_count}"
        )
        return {
            "model": compiled_model,
            "input": compiled_model.input(0),
            "output": compiled_model.output(0),
            "pool": pool,
            "path": model_xml,
            "precision": loaded_precision,
            "input_size": input_size,
            "requested_properties": properties,
            "actual_properties": actual,
            "compile_fallback": fallback,
            "convolutions": convolutions,
            "int8_convolutions": int8_convolutions,
        }

    def _ensure_runtime(self, input_size: int) -> dict:
        if input_size in self._runtimes:
            return self._runtimes[input_size]
        with self._runtime_lock:
            if input_size not in self._runtimes:
                self._runtimes[input_size] = self._compile_runtime(input_size)
        return self._runtimes[input_size]

    def _available_input_sizes(self) -> list[int]:
        available: list[int] = []
        for input_size in (960, 640, 512, 416):
            try:
                self._resolve_model_xml(input_size)
                available.append(input_size)
            except RuntimeError:
                continue
        return available

    def _runtime_for_hint(self, input_size_hint: int | None) -> dict:
        requested_size = int(input_size_hint) if input_size_hint else self.input_size
        requested_size = max(128, min(self.input_size, requested_size))
        available = self._available_input_sizes()
        candidates = [size for size in available if size <= requested_size]
        selected_size = max(candidates) if candidates else self.input_size
        if selected_size not in available:
            selected_size = self.input_size
        self._last_selected_size = selected_size
        return self._ensure_runtime(selected_size)

    def load(self) -> None:
        if self.model is not None:
            return
        runtime = self._ensure_runtime(self.input_size)
        self.model = runtime["model"]
        self.loaded_model_path = runtime["path"]
        self.loaded_precision = runtime["precision"]

    def _preprocess(self, frame, target_size: int | None = None):
        input_size = int(target_size or self.input_size)
        h, w = frame.shape[:2]
        scale = min(input_size / w, input_size / h)
        resized_w = int(round(w * scale))
        resized_h = int(round(h * scale))
        pad_x = (input_size - resized_w) // 2
        pad_y = (input_size - resized_h) // 2

        resized = cv2.resize(frame, (resized_w, resized_h), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((input_size, input_size, 3), 114, dtype=np.uint8)
        canvas[pad_y:pad_y + resized_h, pad_x:pad_x + resized_w] = resized
        blob = canvas[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
        return blob[None, ...], scale, pad_x, pad_y, w, h, input_size

    def _pipeline_bump(self, cls: int, stage: str, amount: int = 1) -> None:
        """Funil por classe: raw → conf_pass → to_tracker → from_tracker.
        Contadores de diagnóstico (GIL torna o incremento seguro o bastante)."""
        bucket = self._pipeline_stats.setdefault(int(cls), {
            "raw": 0, "conf_pass": 0, "to_tracker": 0, "from_tracker": 0,
        })
        bucket[stage] = bucket.get(stage, 0) + int(amount)

    def _rider_for(self, context_key: str) -> RiderAssociator:
        key = str(context_key or "")
        with self._rider_lock:
            associator = self._riders.get(key)
            if associator is None:
                associator = RiderAssociator(
                    self._rider_config, PERSON_CLASS_ID, RIDER_VEHICLE_CLASS_IDS
                )
                self._riders[key] = associator
            return associator

    def _track_people(self, detections: list[Detection], context_key: str, frame=None, timestamp=None) -> list[Detection]:
        # 1) associação de piloto ANTES do tracker: promove pessoa fraca montada
        #    em moto/bicicleta forte e descarta as fracas não promovidas.
        association_candidates = [d for d in detections if (d.extra or {}).get("associationOnly")]
        detections = self._rider_for(context_key).apply(
            detections, self.class_confidence.get(PERSON_CLASS_ID, self.min_conf)
        )
        # Rider promotion and low-score association are different decisions.
        # A weak candidate may associate ONLY to an existing ByteTrack ID.
        if self._low_association and self.tracker_name == "bytetrack":
            present = {id(d) for d in detections}
            detections.extend(d for d in association_candidates if id(d) not in present)

        output: list[Detection] = []
        grouped: dict[int, list[Detection]] = {}
        for item in detections:
            cls = int((item.extra or {}).get("classId", PERSON_CLASS_ID))
            grouped.setdefault(cls, []).append(item)

        # 2) movimento GLOBAL da câmera: estimado UMA vez por frame e aplicado a
        #    todos os backends desta câmera (PTZ/vibração). Default: desligado.
        global_shift = (0.0, 0.0, 1.0)
        if self._motion_comp_enabled and frame is not None:
            estimator = self._motion_estimators.get(context_key)
            if estimator is None:
                estimator = self._motion_estimators.setdefault(context_key, GlobalMotionEstimator())
            global_shift = estimator.estimate(frame)

        with self._tracker_lock:
            for cls in sorted(self.active_class_ids):
                class_detections = grouped.get(cls, [])
                tracker_key = f"{context_key}:class:{cls}"
                backend = self._trackers.get(tracker_key)
                if backend is None:
                    backend = create_tracker(
                        self.tracker_name,
                        class_id=cls,
                        activation_threshold=self._confidence_for_class(cls),
                        lost_track_buffer=self.track_buffer,
                        frame_rate=int(max(1, round(float(GENERAL_PROFILE["detection_fps"])))),
                        low_conf_floor=float(GENERAL_PROFILE.get("low_conf_floor", 0.10)),
                        recovery_grace_ms=int(GENERAL_PROFILE.get("recovery_grace_ms", 2000)),
                        stationary_frames=int(GENERAL_PROFILE.get("stationary_frames", 10)),
                        stationary_iou=float(GENERAL_PROFILE.get("stationary_iou", 0.88)),
                        stationary_out_iou=float(GENERAL_PROFILE.get("stationary_out_iou", 0.70)),
                        appearance=bool(GENERAL_PROFILE.get("tracker_appearance", True)),
                        appearance_veto=float(GENERAL_PROFILE.get("tracker_appearance_veto", 0.10)),
                        min_hits=int(GENERAL_PROFILE.get("tracker_min_hits", 1)),
                        stationary_coast=bool(GENERAL_PROFILE.get("stationary_coast", True)),
                        legacy_thresholds=bool(GENERAL_PROFILE.get("tracker_legacy_thresholds", False)),
                    )
                    self._trackers[tracker_key] = backend

                if global_shift != (0.0, 0.0, 1.0):
                    backend.apply_global_shift(*global_shift)

                if class_detections:
                    xyxy = np.asarray([item.bbox for item in class_detections], dtype=np.float32)
                    confidences = np.asarray([item.confidence for item in class_detections], dtype=np.float32)
                else:
                    xyxy = np.zeros((0, 4), dtype=np.float32)
                    confidences = np.zeros((0,), dtype=np.float32)
                self._pipeline_bump(cls, "to_tracker", len(class_detections))

                if self.tracker_name == "bytetrack":
                    tracked_boxes = backend.update(xyxy, confidences, frame=frame, timestamp=timestamp)
                else:
                    tracked_boxes = backend.update(xyxy, confidences, frame=frame)
                self._pipeline_bump(cls, "from_tracker", len(tracked_boxes))

                for tracked in tracked_boxes:
                    tracked_cls = int(tracked.class_id)
                    raw_track_id = int(tracked.track_id)
                    output.append(
                        Detection(
                            label=CLASS_LABELS.get(tracked_cls, "detected"),
                            confidence=float(tracked.confidence),
                            bbox=[int(value) for value in tracked.bbox.tolist()],
                            extra={
                                "classId": tracked_cls,
                                "overlayMode": GENERAL_PROFILE["overlay_mode"],
                                "trackId": int(tracked_cls * 100000 + raw_track_id),
                                "rawTrackId": raw_track_id,
                                "trackClassId": tracked_cls,
                                "riderVehicleProxy": tracked_cls in RIDER_VEHICLE_CLASS_IDS,
                                "vehicleProxy": tracked_cls in VEHICLE_CLASS_IDS,
                                "stationary": bool(tracked.stationary),
                                "recovered": bool(tracked.recovered),
                                "observedByModel": True,
                                "trackingSource": "model",
                                "estimated": False,
                                "associationOnly": float(tracked.confidence) < self._confidence_for_class(tracked_cls),
                            },
                        )
                    )
        return output

    def _confidence_for_class(self, cls: int) -> float:
        if cls in self.class_confidence:
            return float(self.class_confidence[cls])
        if cls in VEHICLE_CLASS_IDS:
            return float(self.vehicle_min_conf)
        return float(self.min_conf)

    @property
    def accepts_motion_regions(self) -> bool:
        """True quando a inferência por região está LIGADA (padrão: False).

        O StreamProcessor consulta isto antes de sequer montar a lista de caixas
        de movimento: com a flag desligada nenhum argumento novo chega ao infer().
        """
        return bool(self._region_config.enabled)

    def _planner_for(self, context_key: str | None):
        """Planejador (cache de cena) por câmera — criado sob demanda."""
        key = str(context_key or "")
        # Tudo sob o mesmo lock: uma busca em dict é irrelevante perto de uma
        # inferência, e o par (planejador, lock) nunca pode ser visto pela metade
        # por outra câmera criando o seu.
        with self._region_registry_lock:
            if key not in self._region_planners:
                self._region_planner_locks[key] = threading.Lock()
                self._region_planners[key] = MotionRegionPlanner(self._region_config)
            return self._region_planners[key], self._region_planner_locks[key]

    def _infer_by_regions(self, frame, runtime, motion_boxes, context_key: str | None,
                          allowed_class_ids: set[int] | None = None) -> list[Detection]:
        """Roda o modelo NAS REGIÕES do movimento, em resolução nativa.

        As coordenadas voltam para o frame INTEIRO (a região é uma fatia, então
        basta somar a origem — o recorte não é redimensionado antes da inferência,
        quem escala é o letterbox do _preprocess, que o pós-processamento já
        desfaz). Objetos parados são reaproveitados do cache em vez de reinferidos.
        """
        frame_height, frame_width = frame.shape[:2]
        planner, lock = self._planner_for(context_key)
        with lock:
            plan = planner.plan((frame_height, frame_width), motion_boxes)
            self._region_runs += 1
            self._region_stationary_skips += int(plan.skipped)
            if plan.sweep:
                self._region_sweeps += 1
            if plan.idle:
                self._region_idle_full_frames += 1

            fresh: list[Detection] = []
            executed: list[tuple[int, int, int, int]] = []
            for region in plan.regions:
                x1, y1, x2, y2 = region
                crop = frame[y1:y2, x1:x2]
                if getattr(crop, "size", 0) == 0:
                    continue
                found, ran = self._detect_raw(crop, runtime, allowed_class_ids=allowed_class_ids)
                if not ran:
                    # Pool ocupado: a região NÃO rodou. Não pode entrar em
                    # `executed`, senão o cache concluiria que o objeto sumiu por
                    # causa de uma inferência que nunca aconteceu.
                    continue
                executed.append(region)
                self._region_crops += 1
                for detection in found:
                    bx1, by1, bx2, by2 = detection.bbox
                    detection.bbox = [bx1 + x1, by1 + y1, bx2 + x1, by2 + y1]
                    detection.extra = {**(detection.extra or {}), "region": [x1, y1, x2, y2]}
                fresh.extend(found)
            return planner.commit(fresh, plan, executed_regions=executed)

    def infer(
        self,
        frame,
        context_key: str | None = None,
        input_size_hint: int | None = None,
        motion_boxes=None,
        allowed_classes: set[str] | None = None,
        native_frame=None,
        native_motion_boxes=None,
        timestamp: float | None = None,
        context_owner=None,
        confirmed_track_ids=None,
        **kwargs,
    ) -> list[Detection]:
        permitted = None if allowed_classes is None else {normalizar_classe(c) for c in allowed_classes}
        allowed_class_ids = None if permitted is None else {
            CLASS_IDS_BY_NAME[c] for c in permitted if c in CLASS_IDS_BY_NAME
        }
        if allowed_class_ids is not None and not allowed_class_ids:
            if context_key:
                self.release_context(context_key, context_owner)
            return ObjectInference((), "blocked", 0)
        if context_key:
            state = self._context_for(context_key)
            with state["lock"]:
                if context_owner is not None and state.get("owner") != context_owner:
                    state["bridge"].clear()
                    state["fingerprint"] = None
                    state["owner"] = context_owner
                    with self._tracker_lock:
                        for key in [k for k in self._trackers if k.startswith(f"{context_key}:class:")]:
                            self._trackers.pop(key, None)
                fingerprint = (None if permitted is None else frozenset(permitted), frame.shape[:2], input_size_hint)
                if state["fingerprint"] != fingerprint:
                    previous = state["fingerprint"]
                    if previous is not None and previous[1] != frame.shape[:2]:
                        oh, ow = previous[1]
                        nh, nw = frame.shape[:2]
                        with self._tracker_lock:
                            for key, backend in self._trackers.items():
                                if key.startswith(f"{context_key}:class:"):
                                    rescale = getattr(backend, "rescale_coordinates", None)
                                    if callable(rescale):
                                        rescale(nw / ow, nh / oh)
                                    else:
                                        backend.apply_global_shift(0, 0, nw / ow)
                    state["bridge"].clear()
                    state["fingerprint"] = fingerprint
                now = time.monotonic() if timestamp is None else float(timestamp)
                if not math.isfinite(now):
                    raise ValueError("object timestamp must be finite")
                state["last_used"] = time.monotonic()
                temporal = bool(timestamp is not None and GENERAL_PROFILE["persistent_track_id"]
                                and self.tracker_name == "bytetrack" and not self._region_config.enabled)
                if temporal:
                    started = time.perf_counter()
                    bridge = state["bridge"]
                    if confirmed_track_ids is not None and any(
                            d.extra.get("trackId") not in confirmed_track_ids for d in bridge.items):
                        visual = bridge._fallback("awaiting_event_evidence")
                    else:
                        try:
                            visual = bridge.advance(frame, motion_boxes, now)
                        except Exception:
                            # The optional visual shortcut must never blind the
                            # real detector if OpenCV/feature tracking fails.
                            visual = bridge._fallback("visual_error")
                    state["bridge"].stats["visual_ms"] += (time.perf_counter() - started) * 1000
                    if visual is not None:
                        return ObjectInference(visual if permitted is None else filtrar_deteccoes_por_classe(visual, permitted), "visual", 0)
                result, ran = self._infer_model_frame(frame, context_key, input_size_hint, motion_boxes,
                                                     permitted, allowed_class_ids, native_frame,
                                                     native_motion_boxes, now, state)
                if temporal and ran:
                    try:
                        state["bridge"].seed(frame, result, now)
                    except Exception:
                        state["bridge"].clear()
                        state["bridge"]._fallback("seed_error")
                return result
        result, _ = self._infer_model_frame(frame, None, input_size_hint, motion_boxes, permitted,
                                            allowed_class_ids, None, None, None, None)
        return result

    accepts_temporal_context = True

    def _context_for(self, context_key):
        with self._context_lock:
            state = self._contexts.get(context_key)
            if state is None:
                state = {"lock": threading.RLock(), "bridge": VisualTrackBridge(self._visual_config),
                         "fingerprint": None, "frames": 0, "last_used": time.monotonic()}
                self._contexts[context_key] = state
            return state

    def release_context(self, context_key, context_owner=None):
        with self._context_lock:
            state = self._contexts.get(context_key)
            if state is not None and context_owner is not None and state.get("owner") != context_owner:
                return
            state = self._contexts.pop(context_key, None)
        if state is not None:
            with state["lock"]:
                state["bridge"].clear()
                with self._tracker_lock:
                    for key in [k for k in self._trackers if k.startswith(f"{context_key}:class:")]:
                        self._trackers.pop(key, None)
                    self._motion_estimators.pop(context_key, None)
                with self._rider_lock:
                    self._riders.pop(context_key, None)
                with self._region_registry_lock:
                    self._region_planners.pop(context_key, None)
                    self._region_planner_locks.pop(context_key, None)

    def _infer_model_frame(self, frame, context_key, input_size_hint, motion_boxes, permitted,
                           allowed_class_ids, native_frame, native_motion_boxes, timestamp, state):
        if self.model is None:
            self.load()
        runtime = self._runtime_for_hint(input_size_hint)
        model_calls = 1
        if self._region_config.enabled and motion_boxes is not None:
            detections = self._infer_by_regions(frame, runtime, motion_boxes, context_key, allowed_class_ids)
            ran = True  # Legacy region planner owns its execution/cache semantics.
        else:
            allow_tracking = bool(context_key and GENERAL_PROFILE["persistent_track_id"]
                                  and self.tracker_name == "bytetrack" and self._low_association)
            detections, ran = self._detect_raw(frame, runtime, allowed_class_ids=allowed_class_ids,
                                               allow_tracking=allow_tracking)
            if not ran:
                # No observation happened. Never age IDs as though YOLO saw nothing.
                return ObjectInference((), "busy", 0), False
            if state is not None:
                state["frames"] += 1
            if (self._native_config.enabled and native_frame is not None and state is not None
                    and state["frames"] % self._native_config.every_model_frames == 0
                    and int(runtime["input_size"]) >= 416
                    and timestamp >= state.get("roi_retry_after", 0)):
                try:
                    region = choose_native_roi(native_frame.shape, native_motion_boxes, self._native_config)
                    if region is not None and self._native_config.input_size in self._available_input_sizes():
                        roi_runtime = self._ensure_runtime(self._native_config.input_size)
                        x1, y1, x2, y2 = region
                        found, roi_ran = self._detect_raw(native_frame[y1:y2, x1:x2], roi_runtime,
                                                         allowed_class_ids=allowed_class_ids)
                        if roi_ran:
                            model_calls += 1
                            self._native_roi_runs += 1
                            projected = project_native_crop(found, region, native_frame.shape, frame.shape,
                                                             confidence_floor=self._native_config.confidence_floor)
                            detections = merge_native_crop(detections, projected)
                except Exception as exc:
                    self._native_roi_errors += 1
                    state["roi_retry_after"] = timestamp + 30
                    if self._native_roi_errors == 1 or self._native_roi_errors % 100 == 0:
                        print(f"[ObjectDetector] Optional native crop failed ({type(exc).__name__}); whole-frame result kept")
        if permitted is not None:
            # Cached regions may belong to an earlier permission set.
            detections = filtrar_deteccoes_por_classe(detections, permitted)
        if GENERAL_PROFILE["persistent_track_id"] and context_key:
            detections = self._track_people(detections, context_key, frame=frame, timestamp=timestamp)
        if permitted is not None:
            # Tracking can coast previously allowed objects after revocation.
            detections = filtrar_deteccoes_por_classe(detections, permitted)
        return ObjectInference(detections, "model", model_calls), ran

    def _detect_raw(self, frame, runtime, allowed_class_ids: set[int] | None = None,
                    allow_tracking: bool = False) -> tuple[list[Detection], bool]:
        """Inferência + pós-processamento NAS COORDENADAS de `frame`.

        `frame` é o quadro inteiro (caminho de hoje) ou o recorte de uma região.
        O segundo retorno diz se a inferência REALMENTE rodou (False = pool
        ocupado/ausente), informação que o cache de estacionários precisa.
        """
        selected_size = int(runtime["input_size"])
        pool = runtime["pool"]
        if pool is None:
            return [], False
        if not self._global_requests.acquire(blocking=False):
            self._global_busy_drops += 1
            return [], False
        # Latest-frame semantics: if no request is available now, drop this
        # frame and let the next loop consume the newest one from the camera queue.
        try:
            infer_request = pool.get_nowait()
        except Empty:
            self._global_requests.release()
            self._pool_busy_drops += 1
            self._pool_busy_drops_by_size[selected_size] = self._pool_busy_drops_by_size.get(selected_size, 0) + 1
            return [], False
        try:
            # Reserve a worker before allocating/resizing the full image.
            # If all workers are occupied, this frame is skipped anyway.
            blob, scale, pad_x, pad_y, width, height, _ = self._preprocess(frame, selected_size)
            infer_started = time.perf_counter()
            infer_request.infer({runtime["input"]: blob})
            raw = np.array(infer_request.get_output_tensor(0).data, copy=True)
            self._real_infer_runs += 1
            self._infer_ms += (time.perf_counter() - infer_started) * 1000
        finally:
            pool.put(infer_request)
            self._global_requests.release()
        rows = np.squeeze(raw, axis=0)

        detections: list[Detection] = []
        for row in rows:
            if len(row) < 6:
                continue
            x1, y1, x2, y2, score, cls_id = row[:6]
            if not all(np.isfinite(v) for v in (x1, y1, x2, y2, score, cls_id)):
                continue
            cls = int(cls_id)
            if cls not in self.active_class_ids:
                continue
            # LICENÇA antes de qualquer contagem: classe não liberada pela
            # Central não vira detecção nem entra no funil — senão o operador
            # veria "raw" alto de uma classe que jamais aparece na tela.
            if not classe_liberada(cls, allowed_class_ids):
                continue
            self._pipeline_bump(cls, "raw")
            min_conf = self._confidence_for_class(cls)
            below_threshold = bool(score < min_conf)
            if below_threshold:
                # Pessoa FRACA só sobrevive se a associação de piloto estiver
                # ligada e a confiança passar do piso dela — o rider decide o
                # destino (promover ou descartar) ANTES do tracker.
                keep_for_rider = (
                    self._rider_config.enabled
                    and cls == PERSON_CLASS_ID
                    and float(score) >= self._rider_config.person_floor
                )
                keep_for_association = allow_tracking and float(score) > max(0.10, float(GENERAL_PROFILE.get("low_conf_floor", 0.10)))
                if not keep_for_rider and not keep_for_association:
                    continue
            else:
                self._pipeline_bump(cls, "conf_pass")
            x1 = int(max(0, min(width, (float(x1) - pad_x) / scale)))
            y1 = int(max(0, min(height, (float(y1) - pad_y) / scale)))
            x2 = int(max(0, min(width, (float(x2) - pad_x) / scale)))
            y2 = int(max(0, min(height, (float(y2) - pad_y) / scale)))
            if x2 <= x1 or y2 <= y1 or (y2 - y1) < self.min_object_height:
                continue
            detections.append(
                Detection(
                    label=CLASS_LABELS.get(cls, "pessoa"),
                    confidence=float(score),
                    bbox=[x1, y1, x2, y2],
                    extra={
                        "classId": cls,
                        "overlayMode": GENERAL_PROFILE["overlay_mode"],
                        "riderVehicleProxy": cls in RIDER_VEHICLE_CLASS_IDS,
                        "vehicleProxy": cls in VEHICLE_CLASS_IDS,
                        "belowThreshold": below_threshold,
                        "associationOnly": bool(below_threshold and allow_tracking),
                    },
                )
            )
        return detections, True

    def status(self) -> dict:
        loaded_variants = {
            str(size): {
                "path": runtime["path"],
                "precision": runtime["precision"],
                "pool_busy_drops": self._pool_busy_drops_by_size.get(size, 0),
                "requested_properties": runtime.get("requested_properties", {}),
                "actual_properties": runtime.get("actual_properties", {}),
                "compile_fallback": runtime.get("compile_fallback"),
                "convolutions": runtime.get("convolutions"),
                "int8_convolutions": runtime.get("int8_convolutions"),
            }
            for size, runtime in sorted(self._runtimes.items(), reverse=True)
        }
        return {
            "model": self.model_name,
            "requested_precision": self.requested_precision,
            "active_precision": self.loaded_precision,
            "inference_threads": self.inference_threads,
            "infer_workers": self.inference_workers,
            "pool_busy_drops": self._pool_busy_drops,
            "global_request_limit": self._global_request_limit,
            "global_busy_drops": self._global_busy_drops,
            "real_infer_runs": self._real_infer_runs,
            "real_infer_avg_ms": round(self._infer_ms / max(1, self._real_infer_runs), 3),
            "native_roi": {"enabled": self._native_config.enabled, "runs": self._native_roi_runs,
                           "errors": self._native_roi_errors,
                           "every_model_frames": self._native_config.every_model_frames,
                           "confidence_floor": self._native_config.confidence_floor},
            "visual_tracking": self.temporal_status(),
            "loaded_model_path": self.loaded_model_path,
            "input_size_override_supported": False,
            "fixed_model_switching": True,
            "available_input_sizes": self._available_input_sizes(),
            "loaded_variants": loaded_variants,
            "last_selected_input_size": self._last_selected_size,
            "active_class_ids": sorted(self.active_class_ids),
            "class_confidence": {str(key): value for key, value in sorted(self.class_confidence.items())},
            "openvino_device": self.openvino_device,
            "openvino_performance_hint": self.openvino_performance_hint,
            "region_detection": self.region_status(),
            "tracker": self.tracker_status(),
        }

    def temporal_status(self):
        with self._context_lock:
            states = list(self._contexts.items())
        result = {}
        for key, state in states:
            if not state["lock"].acquire(blocking=False):
                result[key] = {"busy": True}
                continue
            try:
                result[key] = state["bridge"].status()
            finally:
                state["lock"].release()
        return {"enabled": self._visual_config.enabled, "per_camera": result,
                "estimated_boxes_confirm_events": False}

    def tracker_status(self) -> dict:
        """Diagnóstico do funil detector→tracker e dos backends por câmera.

        `pipeline` responde diretamente o caso "4 detecções perto × 145 longe":
        se `raw` já é baixo, o problema é modelo/pré-processamento; se `raw` é
        alto e `conf_pass` é baixo, é threshold; se `to_tracker` é alto e
        `from_tracker` é baixo, é o tracker.
        """
        with self._tracker_lock:
            backends = {key: backend.status() for key, backend in self._trackers.items()}
        with self._rider_lock:
            rider = {
                "enabled": self._rider_config.enabled,
                "per_camera": {key: dict(associator.stats) for key, associator in self._riders.items()},
            }
        return {
            "name": self.tracker_name,
            "available": tracker_names(),
            "pipeline": {
                CLASS_LABELS.get(cls, str(cls)): dict(stats)
                for cls, stats in sorted(self._pipeline_stats.items())
            },
            "camera_motion_comp": self._motion_comp_enabled,
            "rider_association": rider,
            "backends": backends,
        }

    def region_status(self) -> dict:
        with self._region_registry_lock:
            contexts = {key: planner.stats() for key, planner in sorted(self._region_planners.items())}
        return {
            "enabled": bool(self._region_config.enabled),
            "config": self._region_config.as_dict(),
            "region_runs": self._region_runs,
            "region_crops": self._region_crops,
            "stationary_skips": self._region_stationary_skips,
            "sweeps": self._region_sweeps,
            "idle_full_frames": self._region_idle_full_frames,
            "contexts": contexts,
        }
