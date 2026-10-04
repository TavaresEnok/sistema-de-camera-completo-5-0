"""Single static detector registry per active AI mode."""

import threading

from detectors import build_detector
from detectors.base import Detector


class ModelRegistry:
    """Cache thread-safe de um detector fixo por modo."""

    def __init__(self):
        self._lock = threading.Lock()   # serializa carregamento; o detector serializa inferência
        self._cache: dict[str, Detector] = {}
        self._loading: dict[str, threading.Event] = {}
        self.last_error: str | None = None

    def _cache_key(self, analysis_type: str) -> str:
        mode = (analysis_type or "motion").strip().lower()
        return mode

    def ensure_detector(self, analysis_type: str) -> Detector:
        """Retorna (carregando se necessário) o detector fixo do modo.

        Dois threads que peçam o mesmo modo ao mesmo tempo vão:
        - Um deles carrega o modelo
        - O outro espera o evento e usa o modelo já carregado
        """
        key = self._cache_key(analysis_type)

        # Fast-path: já está no cache
        if key in self._cache:
            return self._cache[key]

        # Slow-path: primeiro a chegar carrega, demais esperam
        with self._lock:
            if key in self._cache:
                return self._cache[key]

            # Cria evento de sincronização para outros threads esperarem
            if key not in self._loading:
                self._loading[key] = threading.Event()
                should_load = True
            else:
                should_load = False

        if not should_load:
            # Outro thread está carregando — esperar até 120s
            self._loading[key].wait(timeout=120)
            det = self._cache.get(key)
            if det is None:
                raise RuntimeError(f"Detector '{key}' falhou ao carregar no thread anterior.")
            return det

        # Este thread é o responsável por carregar
        try:
            print(f"[ModelRegistry] Carregando detector '{key}'...")
            det = build_detector(analysis_type)
            det.load()
            self._cache[key] = det
            print(f"[ModelRegistry] Detector '{key}' pronto.")
            return det
        except Exception as exc:
            self.last_error = str(exc)
            print(f"[ModelRegistry] ERRO ao carregar '{key}': {exc}")
            raise
        finally:
            # Notifica threads que estavam esperando
            with self._lock:
                event = self._loading.pop(key, None)
            if event:
                event.set()

    # ── API de compatibilidade (usada por main.py /models/load) ──────────

    @property
    def mode(self) -> str | None:
        """Retorna o modo do primeiro detector carregado (compatibilidade)."""
        for key in self._cache:
            return key.split(":")[0] or None
        return None

    @property
    def event_type(self) -> str:
        """Retorna o event_type do primeiro detector (compatibilidade)."""
        for det in self._cache.values():
            return getattr(det, "event_type", "GENERIC")
        return "GENERIC"

    def ensure_mode(self, analysis_type: str) -> Detector:
        """Atalho sem config específica (carrega com defaults globais)."""
        return self.ensure_detector(analysis_type)

    def infer(self, analysis_type: str, frame, context_key: str | None = None):
        """Inferência usando o detector fixo cacheado para este modo."""
        det = self.ensure_detector(analysis_type)
        return det.infer(frame, context_key=context_key)

    def reset(self):
        """Libera todos os detectores do cache (para hot-reload de modo)."""
        with self._lock:
            for det in self._cache.values():
                try:
                    det.close()
                except Exception:
                    pass
            self._cache.clear()
            self._loading.clear()
            self.last_error = None

    def status(self) -> dict:
        """Read-only diagnostic snapshot."""
        detector_status: dict[str, dict] = {}
        for key, det in self._cache.items():
            status_fn = getattr(det, "status", None)
            if callable(status_fn):
                try:
                    detector_status[key] = status_fn()
                except Exception:
                    detector_status[key] = {"error": "status_unavailable"}
        return {
            "mode": self.mode,
            "cached_detectors": list(self._cache.keys()),
            "loading": list(self._loading.keys()),
            "lastError": self.last_error,
            "detectors": detector_status,
        }

    def release_context(self, context_key, context_owner=None):
        with self._lock:
            detectors = list(self._cache.values())
        for detector in detectors:
            release = getattr(detector, "release_context", None)
            if callable(release):
                release(context_key, context_owner)


registry = ModelRegistry()
