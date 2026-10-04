"""Registro de backends de tracking (mesmo padrão do registro de detectores).

Hoje o valor de GENERAL_TRACKER era lido e ignorado — o sv.ByteTrack ficava
hardcoded dentro do ObjectDetector. Este pacote fecha esse buraco:

    from trackers import create_tracker, tracker_names

    backend = create_tracker("bytetrack", class_id=0, activation_threshold=0.30,
                             lost_track_buffer=20, frame_rate=4)

Backends disponíveis:
    - "bytetrack": sv.ByteTrack com início explícito por classe e recuperação
      limitada por tempo real. GENERAL_TRACKER_LEGACY_THRESHOLDS restaura
      os gates/buffer anteriores para comparação ou rollback.
    - "ajustcam":  tracker próprio para CFTV — associação pelo pé da caixa
      (bottom-center) normalizada pelo tamanho, Kalman de velocidade constante,
      associação em dois estágios (alta/baixa confiança), janela de oclusão com
      recuperação de ID, classificação de objeto estacionário e compensação de
      movimento global de câmera (hook para PTZ).

Valor inválido de GENERAL_TRACKER agora FALHA com erro claro na inicialização,
em vez de ser ignorado silenciosamente.
"""
from __future__ import annotations

from .base import TrackedBox, TrackerBackend
from .bytetrack_backend import ByteTrackBackend
from .ajustcam_tracker import AjustCamTracker

_REGISTRY: dict[str, type[TrackerBackend]] = {
    "bytetrack": ByteTrackBackend,
    "ajustcam": AjustCamTracker,
}


def tracker_names() -> list[str]:
    return sorted(_REGISTRY.keys())


def create_tracker(name: str, **kwargs) -> TrackerBackend:
    key = str(name or "").strip().lower()
    if key not in _REGISTRY:
        raise ValueError(
            f"GENERAL_TRACKER='{name}' não é um tracker válido. "
            f"Opções: {', '.join(tracker_names())}"
        )
    return _REGISTRY[key](**kwargs)


__all__ = [
    "TrackedBox",
    "TrackerBackend",
    "ByteTrackBackend",
    "AjustCamTracker",
    "create_tracker",
    "tracker_names",
]
