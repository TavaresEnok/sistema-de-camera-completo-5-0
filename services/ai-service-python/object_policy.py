"""Política por câmera para objetos, recebida da API em ``source_info``.

O detector continua com limiar baixo para não perder o rastreamento. Esta
camada restringe as classes exibidas/emitidas e regula apenas a confirmação do
evento, que é a parte segura de tornar mais sensível ou mais precisa.
"""

from __future__ import annotations


_ALIASES = {
    "person": "person", "pessoa": "person",
    "bicycle": "bicycle", "bicicleta": "bicycle", "bike": "bicycle",
    "car": "car", "carro": "car",
    "motorcycle": "motorcycle", "moto": "motorcycle",
    "bus": "bus", "onibus": "bus", "ônibus": "bus",
    "truck": "truck", "caminhao": "truck", "caminhão": "truck",
    "dog": "dog", "cachorro": "dog",
    "cat": "cat", "gato": "cat",
}


def normalizar_classe(valor) -> str:
    chave = str(valor or "").strip().lower()
    return _ALIASES.get(chave, chave)


def politica_de_objeto(source_info, *, default_threshold=0.70, default_min_frames=3) -> dict:
    bruto = source_info.get("objectDetection", {}) if isinstance(source_info, dict) else {}
    bruto = bruto if isinstance(bruto, dict) else {}
    classes_brutas = bruto.get("classes")
    classes = {
        normalizar_classe(item)
        for item in classes_brutas
        if normalizar_classe(item)
    } if isinstance(classes_brutas, list) else set()

    try:
        threshold = float(bruto.get("confirmThreshold", default_threshold))
    except (TypeError, ValueError):
        threshold = float(default_threshold)
    try:
        min_frames = int(bruto.get("confirmMinFrames", default_min_frames))
    except (TypeError, ValueError):
        min_frames = int(default_min_frames)

    return {
        # A API sempre envia a lista quando objeto está ativo. Vazio significa
        # bloquear todas, e não "detectar tudo" — a licença segue fail-closed.
        "classes": classes,
        "confirm_threshold": max(0.40, min(0.90, threshold)),
        "confirm_min_frames": max(2, min(6, min_frames)),
    }


def filtrar_deteccoes_por_classe(deteccoes, classes: set[str]):
    if not classes:
        return []
    return [d for d in (deteccoes or []) if normalizar_classe(getattr(d, "label", "")) in classes]


def eh_objeto_para_confirmar(deteccao) -> bool:
    return str(getattr(deteccao, "event_type", None) or "AI_DETECTED") in {
        "AI_DETECTED",
        "OBJECT_DETECTED",
    }
