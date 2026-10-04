"""Static AI runtime profiles.

These values are deliberately code-owned. The API selects a mode, but it
cannot override detector model, thresholds, sizing or overlay behavior.
"""

import os


def _env_bool(name: str, default: bool) -> bool:
    raw = (os.getenv(name, "") or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except Exception:
        return default


def _env_float(name: str, default: float) -> float:
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except Exception:
        return default


def _env_str(name: str, default: str) -> str:
    raw = (os.getenv(name, "") or "").strip()
    return raw if raw else default


def _env_csv_str(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    values = tuple(value.strip() for value in raw.split(",") if value.strip())
    return values or default


def _env_csv_int(name: str, default: tuple[int, ...]) -> tuple[int, ...]:
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    values: list[int] = []
    for value in raw.split(","):
        try:
            values.append(int(value.strip()))
        except Exception:
            continue
    return tuple(values) or default


MOTION_PROFILE = {
    "mode": "motion",
    "detection_fps": _env_float("MOTION_DETECTION_FPS", 7.0),
    "analysis_width": 320,
    "analysis_height": 180,
    "motion_trigger": "SYSTEM",
    # Limiar por OBJETO (componente conectado), como FRAÇÃO da área analisada.
    # 0,0012 = 0,12% da tela (~69 px em 320×180) ≈ pessoa/moto distante — calibrado
    # pelo comparativo de campo com a detecção nativa ONVIF (2026-07-21). O limiar
    # antigo de 1800 px (3,1% da tela) ignorava tudo que não estivesse perto.
    "motion_min_component_ratio": _env_float("MOTION_MIN_COMPONENT_RATIO", 0.0012),
    # Fração da tela mudando de uma vez que caracteriza ALTERAÇÃO GLOBAL
    # (IR dia/noite, exposição, relâmpago, câmera mexida) — reaprende, não dispara.
    "motion_global_change_ratio": _env_float("MOTION_GLOBAL_CHANGE_RATIO", 0.55),
    "motion_min_consecutive_hits": 3,
    # A strong compact region may exist in only one sampled frame (fast pass).
    # Weak/small movement retains temporal confirmation; reversible kill switch.
    "motion_single_frame_strong": str(os.getenv("MOTION_SINGLE_FRAME_STRONG", "true")).strip().lower() != "false",
    # 30 frames a 2 fps = 15s de aprendizado no boot (antes 60 = 30s cego).
    "motion_warmup_frames": _env_int("MOTION_WARMUP_FRAMES", 30),
    # Normalização de contraste pré-diff (padrão Frigate) — essencial à noite.
    "motion_improve_contrast": str(os.getenv("MOTION_IMPROVE_CONTRAST", "true")).strip().lower() != "false",
    # Suavização ANTES do MOG2 (janela ímpar; 0 desliga). O Frigate faz o
    # equivalente com gaussian_filter sigma=1; nós não fazíamos, e o MOG2 —
    # que modela cada pixel isolado — comia ruído de sensor como movimento.
    # Medido em tests/bench_motion_ruido.py, cena PARADA com ruído sigma 10
    # (câmera à noite/ganho alto): 90 de 120 quadros disparavam gravação por
    # ruído puro; com 3x3 caem para ZERO, e pessoa perto/média/longe e de baixo
    # contraste continuam sendo detectadas. Só se perde alvo mais fraco que o
    # próprio ruído (delta 5 sobre sigma 6), que nenhum detector distingue de
    # ruído — era justamente ele que gerava os 90 falsos.
    "motion_blur_ksize": _env_int("MOTION_BLUR_KSIZE", 3),
    # COMPENSACAO FOTOMETRICA GLOBAL: nuvem, farol, exposicao automatica e luz
    # ambiente deslocam quase toda a luminancia na mesma direcao. O guarda mede
    # esse deslocamento em pixels + grade espacial e o remove apenas do frame de
    # analise; um objeto local continua como residuo e segue para o MOG2.
    "motion_illumination_compensation": _env_bool("MOTION_ILLUMINATION_COMPENSATION", True),
    "motion_illumination_min_shift": _env_float("MOTION_ILLUMINATION_MIN_SHIFT", 8.0),
    "motion_illumination_residual_threshold": _env_float("MOTION_ILLUMINATION_RESIDUAL_THRESHOLD", 10.0),
    "motion_illumination_uniform_ratio": _env_float("MOTION_ILLUMINATION_UNIFORM_RATIO", 0.72),
    "motion_illumination_block_uniform_ratio": _env_float("MOTION_ILLUMINATION_BLOCK_UNIFORM_RATIO", 0.75),
    "motion_illumination_alpha": _env_float("MOTION_ILLUMINATION_ALPHA", 0.02),
    # Mantem a referencia lenta tambem durante a compensacao: adaptar rapido
    # faria o segundo quadro de uma luz acesa parecer uma nova mudanca global e
    # poderia engolir uma pessoa que entrou junto.
    "motion_illumination_recovery_alpha": _env_float("MOTION_ILLUMINATION_RECOVERY_ALPHA", 0.02),
    # Se uma mudanca ainda exceder o limite global DEPOIS da compensacao e for
    # inequivocamente fotometrica, nao cria gravacao. Mudancas nao uniformes
    # (camera mexida, PTZ, objeto muito proximo) continuam marcadas/reportadas.
    "motion_photometric_scene_suppression": _env_bool("MOTION_PHOTOMETRIC_SCENE_SUPPRESSION", True),
    # PISO DE RUÍDO ADAPTATIVO (ideia do Shinobi): mediana das últimas N medidas
    # de movimento vira o chão do limiar. Em dia de vento/chuva o detector sobe
    # a própria régua sozinho e desce quando passa — sem ninguém reconfigurar.
    # Mediana (não média) porque uma pessoa atravessando não pode elevar o piso
    # e deixar o detector surdo logo em seguida.
    "motion_noise_floor": str(os.getenv("MOTION_NOISE_FLOOR", "true")).strip().lower() != "false",
    "motion_noise_window": _env_int("MOTION_NOISE_WINDOW", 60),   # ~30 s a 2 fps
    "motion_noise_floor_factor": _env_float("MOTION_NOISE_FLOOR_FACTOR", 1.6),
    # SUPRESSÃO DE ATIVIDADE CRÔNICA (luz piscando, bandeira, água, folha ao
    # vento). Aprende POR PIXEL a fração de tempo em movimento e zera o que fica
    # ativo perto de metade do tempo — algo que o piso de ruído GLOBAL não pega
    # (uma luz num canto não move a mediana da tela). Auto-aprende e auto-esquece.
    # É a diferença medida contra o Frigate: lá a luz piscando exige máscara
    # manual; aqui some sozinha. Ver detectors/chronic_activity.py.
    "motion_chronic_suppression": str(os.getenv("MOTION_CHRONIC_SUPPRESSION", "true")).strip().lower() != "false",
    "motion_chronic_alpha": _env_float("MOTION_CHRONIC_ALPHA", 0.02),   # aprende luz piscando em ~20 s a 2 fps
    "motion_chronic_threshold": _env_float("MOTION_CHRONIC_THRESHOLD", 0.45),  # ativa ~metade do tempo = crônico
    "motion_chronic_warmup": _env_int("MOTION_CHRONIC_WARMUP", 60),     # não suprime nada antes disto
    # DESCARTE DE DISPARO PERIÓDICO: o que é mecânico tem relógio (luz de aviso,
    # letreiro, ventilador). Cobre a lacuna do mapa crônico acima, que só pega o
    # que fica ativo boa parte do tempo — piscada LENTA passa por lá e é pega
    # aqui, pela REGULARIDADE dos intervalos. Ver detectors/periodicity.py.
    "motion_periodic_suppression": str(os.getenv("MOTION_PERIODIC_SUPPRESSION", "true")).strip().lower() != "false",
    "motion_periodic_cells": _env_int("MOTION_PERIODIC_CELLS", 8),          # grade grosseira: pessoa andando muda de célula
    "motion_periodic_min_samples": _env_int("MOTION_PERIODIC_MIN_SAMPLES", 6),  # não julga com poucas amostras
    "motion_periodic_cv_max": _env_float("MOTION_PERIODIC_CV_MAX", 0.15),   # intervalos variando <15% = máquina
    # Congela o aprendizado do fundo nos primeiros N frames de movimento (padrão
    # Frigate): quem entra e FICA continua sendo detectado; mudança persistente
    # (carro estacionado) é absorvida gradualmente depois.
    "motion_freeze_learning_frames": _env_int("MOTION_FREEZE_LEARNING_FRAMES", 6),
    # MUDANÇA GLOBAL DE CENA (luz acendendo, IR ligando, sol saindo da nuvem):
    # recalibra o fundo E CONTINUA reportando o movimento, marcado com
    # sceneChange=true no metadata. Engolir o evento era não gravar justamente no
    # instante em que algo acontece — e o MOTION_DETECTED é o gatilho da gravação.
    # false = kill-switch, volta ao comportamento antigo (descarta o evento).
    "motion_scene_change_report": _env_bool("MOTION_SCENE_CHANGE_REPORT", True),
    # Roda o MOG2 no plano de LUMINÂNCIA (1 canal) em vez do BGR (3 canais).
    # OPT-IN: o padrão é o caminho de hoje. Objeto que só se distingue por matiz
    # (mesma luminância do fundo) some no plano Y — por isso a troca é consciente.
    "motion_luma_plane": _env_bool("MOTION_LUMA_PLANE", False),
    # Teto de caixas de movimento por frame. O detector devolve um Detection por
    # objeto coeso (maior primeiro); o teto impede que uma cena agitada vire uma
    # lista enorme — cada caixa custa um recorte na confirmação semântica.
    "motion_max_boxes": _env_int("MOTION_MAX_BOXES", 4),
    # O primeiro movimento continua imediato; apenas eventos repetidos da mesma
    # cena são consolidados. Mantém o post-roll da gravação acima deste valor.
    "event_debounce_seconds": _env_int("MOTION_EVENT_DEBOUNCE_SECONDS", 45),
    "show_after_hits": 1,
    "hide_after_misses": 2,
    "lost_ttl_ms": 600,
    "overlay_ttl_ms": 600,
}

FACE_PROFILE = {
    "mode": "face",
    "model": "scrfd_500m",
    "pack": "buffalo_s",
    # Runtime do detector de rostos (onnxruntime). Default CPU. Para acelerar por
    # GPU NVIDIA, suba o serviço com FACE_RUNTIME=onnxruntime_cuda numa imagem com
    # onnxruntime-gpu (ver Dockerfile.gpu). Dormente por padrão.
    "runtime": _env_str("FACE_RUNTIME", "onnxruntime_cpu"),
    "analysis_width": 960,
    "analysis_height": 540,
    "detector_size": 640,
    "detection_fps": 2.0,
    "confidence": 0.35,
    "motion_trigger": "CAMERA",
    "event_debounce_seconds": 10,
    "show_after_hits": 1,
    "hide_after_misses": 2,
    "lost_ttl_ms": 600,
    "overlay_ttl_ms": 600,
    "recognition": False,
}

GENERAL_PROFILE = {
    "mode": _env_str("GENERAL_MODE", "general"),
    "model": _env_str("GENERAL_MODEL", "yolo26n"),
    # Maior modelo que a CPU serve com dignidade quando não há placa.
    # `yolo26n` desde 18/09/2026 (era `yolo26s`, 6× mais caro em CPU e cabia
    # só na matriz). O porquê medido está em detectors/escolha_de_modelo.py.
    "cpu_model_ceiling": _env_str("GENERAL_CPU_MODEL_CEILING", "yolo26n"),
    # ── Pacote de tracking (15/08/2026) — todas com default SEGURO:
    # `tracker=bytetrack` mantém o comportamento atual; rider e
    # compensação de câmera nascem desligados. Rollback do tracking é
    # variável de ambiente, sem redeploy de código.
    "low_conf_floor": _env_float("GENERAL_TRACKER_LOW_CONF_FLOOR", 0.10),
    "recovery_grace_ms": _env_int("GENERAL_TRACKER_RECOVERY_GRACE_MS", 2000),
    "tracker_legacy_thresholds": _env_bool("GENERAL_TRACKER_LEGACY_THRESHOLDS", False),
    "tracker_low_association": _env_bool("GENERAL_TRACKER_LOW_ASSOCIATION", True),
    "visual_tracking": _env_bool("GENERAL_VISUAL_TRACKING", True),
    "visual_refresh_seconds": _env_float("GENERAL_VISUAL_REFRESH_SECONDS", 0.75),
    "visual_max_skips": _env_int("GENERAL_VISUAL_MAX_SKIPS", 2),
    "native_roi": _env_bool("GENERAL_NATIVE_ROI", True),
    "native_roi_every": _env_int("GENERAL_NATIVE_ROI_EVERY", 3),
    "native_roi_confidence": _env_float("GENERAL_NATIVE_ROI_CONFIDENCE", 0.40),
    "global_infer_requests": _env_int("GENERAL_GLOBAL_INFER_REQUESTS", 2),
    "openvino_streams": _env_int("GENERAL_OPENVINO_STREAMS", 1),
    "stationary_frames": _env_int("GENERAL_STATIONARY_FRAMES", 10),
    "stationary_iou": _env_float("GENERAL_STATIONARY_IOU", 0.88),
    "stationary_out_iou": _env_float("GENERAL_STATIONARY_OUT_IOU", 0.70),
    "camera_motion_comp": _env_bool("GENERAL_CAMERA_MOTION_COMP", False),
    "tracker_appearance": _env_bool("GENERAL_TRACKER_APPEARANCE", True),
    "tracker_appearance_veto": _env_float("GENERAL_TRACKER_APPEARANCE_VETO", 0.10),
    "tracker_min_hits": _env_int("GENERAL_TRACKER_MIN_HITS", 1),
    "stationary_coast": _env_bool("GENERAL_STATIONARY_COAST", True),
    "rider_association": _env_bool("GENERAL_RIDER_ASSOCIATION", False),
    "rider_person_floor": _env_float("GENERAL_RIDER_PERSON_FLOOR", 0.12),
    "rider_vehicle_min": _env_float("GENERAL_RIDER_VEHICLE_MIN", 0.45),
    "rider_confirm_frames": _env_int("GENERAL_RIDER_CONFIRM_FRAMES", 2),
    "runtime": _env_str("GENERAL_RUNTIME", "openvino_cpu"),
    "precision": _env_str("GENERAL_PRECISION", "int8"),
    "analysis_width": _env_int("GENERAL_ANALYSIS_WIDTH", 960),
    "analysis_height": _env_int("GENERAL_ANALYSIS_HEIGHT", 540),
    "imgsz": _env_int("GENERAL_IMGSZ", 640),
    "detection_fps": _env_float("GENERAL_DETECTION_FPS", 4.0),
    "motion_trigger": _env_str("GENERAL_MOTION_TRIGGER", "SYSTEM"),
    "event_debounce_seconds": _env_int("GENERAL_EVENT_DEBOUNCE_SECONDS", 10),
    "classes": _env_csv_str("GENERAL_CLASSES", ("person", "bicycle", "car", "motorcycle", "bus")),
    "class_ids": _env_csv_int("GENERAL_CLASS_IDS", (0, 1, 2, 3, 5)),
    "confidence_person": _env_float("GENERAL_CONFIDENCE_PERSON", 0.30),
    "confidence_bicycle": _env_float("GENERAL_CONFIDENCE_BICYCLE", 0.25),
    "confidence_car": _env_float("GENERAL_CONFIDENCE_CAR", 0.25),
    "confidence_motorcycle": _env_float("GENERAL_CONFIDENCE_MOTORCYCLE", 0.25),
    "confidence_rider_vehicle": _env_float("GENERAL_CONFIDENCE_RIDER_VEHICLE", 0.25),
    "confidence_vehicle": _env_float("GENERAL_CONFIDENCE_VEHICLE", 0.25),
    # ── Confirmação por persistência (o "threshold" do Frigate) ──────────────
    # O limiar POR QUADRO acima (confidence_*) é de propósito baixo: ele deixa a
    # detecção entrar no rastreamento e desenhar a caixa na tela. Já virar
    # EVENTO exige que a MEDIANA das confianças do objeto, ao longo de vários
    # quadros, passe deste limiar. Um pico espúrio não arrasta a mediana.
    "confirm_min_frames": _env_int("GENERAL_CONFIRM_MIN_FRAMES", 3),
    "confirm_median_threshold": _env_float("GENERAL_CONFIRM_MEDIAN_THRESHOLD", 0.70),
    "confirm_forget_after_misses": _env_int("GENERAL_CONFIRM_FORGET_AFTER_MISSES", 20),
    "tracker": _env_str("GENERAL_TRACKER", "bytetrack"),
    "track_buffer": _env_int("GENERAL_TRACK_BUFFER", 20),
    "lost_ttl_ms": _env_int("GENERAL_LOST_TTL_MS", 2000),
    "hide_after_misses": _env_int("GENERAL_HIDE_AFTER_MISSES", 5),
    "show_after_hits": _env_int("GENERAL_SHOW_AFTER_HITS", 1),
    "min_object_height_px": _env_int("GENERAL_MIN_OBJECT_HEIGHT_PX", 10),
    "overlay_mode": _env_str("GENERAL_OVERLAY_MODE", "box"),
    "overlay_ttl_ms": _env_int("GENERAL_OVERLAY_TTL_MS", 1800),
    "persistent_track_id": _env_bool("GENERAL_PERSISTENT_TRACK_ID", True),
    "recognition": _env_bool("GENERAL_RECOGNITION", False),
    "face_detection": _env_bool("GENERAL_FACE_DETECTION", False),
    "detect_vehicles": _env_bool("GENERAL_DETECT_VEHICLES", False),
    "detect_animals": _env_bool("GENERAL_DETECT_ANIMALS", False),
    "detect_objects": _env_bool("GENERAL_DETECT_OBJECTS", False),
    "emit_events": _env_bool("GENERAL_EMIT_EVENTS", True),
    "model_path": _env_str("GENERAL_MODEL_PATH", ""),
    "model_input_width": _env_int("GENERAL_MODEL_INPUT_WIDTH", 0),
    "model_input_height": _env_int("GENERAL_MODEL_INPUT_HEIGHT", 0),
    "model_dynamic": _env_bool("GENERAL_MODEL_DYNAMIC", False),
    "model_end2end": _env_bool("GENERAL_MODEL_END2END", True),
    "model_nms": _env_bool("GENERAL_MODEL_NMS", False),
    "openvino_device": _env_str("GENERAL_OPENVINO_DEVICE", "CPU"),
    "openvino_performance_hint": _env_str("GENERAL_OPENVINO_PERFORMANCE_HINT", "LATENCY"),
}


def runtime_profile(mode: str) -> dict:
    selected = (mode or "motion").strip().lower()
    if selected == "face":
        return FACE_PROFILE.copy()
    if selected == "general":
        return GENERAL_PROFILE.copy()
    return MOTION_PROFILE.copy()


def onnxruntime_providers(runtime: str | None) -> list:
    """ONNX Runtime providers para um runtime de perfil.

    'onnxruntime_cuda' / qualquer coisa com 'cuda'/'gpu' → tenta CUDA e cai para CPU.
    Caso contrário → só CPU (comportamento atual, default). Dormente até alguém
    setar FACE_RUNTIME=onnxruntime_cuda numa imagem com onnxruntime-gpu.
    """
    selected = (runtime or "").strip().lower()
    if "cuda" in selected or "gpu" in selected:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def runtime_uses_gpu(runtime: str | None) -> bool:
    selected = (runtime or "").strip().lower()
    return "cuda" in selected or "gpu" in selected


def exposed_profiles() -> dict:
    return {
        "face": FACE_PROFILE.copy(),
        "general": {
            **GENERAL_PROFILE,
            "classes": list(GENERAL_PROFILE["classes"]),
            "class_ids": list(GENERAL_PROFILE["class_ids"]),
        },
    }
