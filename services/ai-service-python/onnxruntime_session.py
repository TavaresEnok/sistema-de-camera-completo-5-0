import math
import os


_PATCHED = False
_DEFAULT_RESERVE_PERCENT = 25
_DEFAULT_WORKER_COUNT = 2
_MAX_RESERVE_PERCENT = 80


def _read_int(path: str) -> int | None:
    try:
        value = (open(path, "r", encoding="utf-8").read() or "").strip()
    except Exception:
        return None
    if not value:
        return None
    try:
        parsed = int(value)
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except Exception:
        return default
    return value


def _available_cpu_threads() -> dict:
    cpu_count = max(1, os.cpu_count() or 1)

    affinity_count: int | None = None
    try:
        affinity_count = len(os.sched_getaffinity(0))
        if affinity_count <= 0:
            affinity_count = None
    except Exception:
        affinity_count = None

    # cgroup v2
    cgroup_quota_count: int | None = None
    try:
        with open("/sys/fs/cgroup/cpu.max", "r", encoding="utf-8") as cpu_file:
            raw = (cpu_file.read() or "").strip()
        quota_str, period_str = raw.split(maxsplit=1)
        if quota_str != "max":
            quota = int(quota_str)
            period = int(period_str)
            if quota > 0 and period > 0:
                cgroup_quota_count = max(1, int(math.floor(quota / period)))
    except Exception:
        pass

    # cgroup v1 fallback
    if cgroup_quota_count is None:
        quota = _read_int("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        period = _read_int("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
        if quota and period and quota > 0 and period > 0:
            cgroup_quota_count = max(1, int(math.floor(quota / period)))

    candidates = [cpu_count]
    if affinity_count is not None:
        candidates.append(affinity_count)
    if cgroup_quota_count is not None:
        candidates.append(cgroup_quota_count)

    available = max(1, min(candidates))
    return {
        "cpu_count": cpu_count,
        "affinity_count": affinity_count,
        "cgroup_quota_count": cgroup_quota_count,
        "available_threads": available,
    }


def _auto_worker_count(cpu_budget: int) -> int:
    """Balanced auto sizing from CPU budget.

    Goal: avoid oversubscription while still allowing multi-camera parallelism.
    Uses roughly sqrt(cpu_budget) workers, each with cpu_budget/workers threads.
    """
    budget = max(1, int(cpu_budget))
    if budget <= 2:
        return 1
    if budget <= 4:
        return 2
    return max(1, int(round(math.sqrt(budget))))


def _worker_count(cpu_budget: int, default: int = _DEFAULT_WORKER_COUNT) -> int:
    raw = (os.getenv("AI_INFERENCE_WORKER_COUNT", "") or "").strip()
    if not raw:
        return max(1, _auto_worker_count(cpu_budget))
    try:
        value = int(raw)
    except Exception:
        value = default
    return max(1, value)


def inference_threading_status(worker_count: int | None = None) -> dict:
    detected = _available_cpu_threads()
    available = int(detected["available_threads"])
    reserve_percent = _env_int("AI_CPU_RESERVE_PERCENT", _DEFAULT_RESERVE_PERCENT)
    reserve_percent = max(0, min(_MAX_RESERVE_PERCENT, reserve_percent))
    cpu_budget = max(1, int(math.floor(available * (100 - reserve_percent) / 100)))

    configured_workers = max(1, int(worker_count or _worker_count(cpu_budget)))
    override_value = _env_int("AI_INFERENCE_THREADS_OVERRIDE", 0)
    override_enabled = override_value > 0

    if override_enabled:
        threads_per_worker = override_value
        effective_workers = configured_workers
        mode = "override"
    else:
        # Keep worker-thread product within budget in automatic mode.
        effective_workers = max(1, min(configured_workers, cpu_budget))
        threads_per_worker = max(1, cpu_budget // effective_workers)
        mode = "automatic"

    # INFERENCE_NUM_THREADS no OpenVINO é o total de threads para o modelo compilado,
    # compartilhado entre todos os NUM_STREAMS. Por isso o total real de OS threads
    # alocados para inferência é apenas threads_per_worker (não ×workers).
    # Em modo automático threads_per_worker = budget//workers, e o produto confirma
    # que o total não ultrapassa o budget. Em modo override o usuário define
    # INFERENCE_NUM_THREADS diretamente, então o total OS é esse valor.
    openvino_threads = threads_per_worker  # = INFERENCE_NUM_THREADS passado ao OpenVINO
    total_threads = threads_per_worker * effective_workers  # mantido para compatibilidade
    within_budget = openvino_threads <= cpu_budget
    return {
        "mode": mode,
        "override_enabled": override_enabled,
        "override_threads_per_worker": override_value if override_enabled else None,
        "reserve_percent": reserve_percent,
        "available_threads": available,
        "cpu_budget": cpu_budget,
        "configured_workers": configured_workers,
        "effective_workers": effective_workers,
        "threads_per_worker": threads_per_worker,
        "openvino_inference_num_threads": openvino_threads,
        "total_inference_threads": total_threads,
        "within_budget": within_budget,
        "detected": detected,
    }


def automatic_inference_threads(worker_count: int | None = None) -> int:
    """Automatic thread budget with optional debug override."""
    return int(inference_threading_status(worker_count=worker_count)["threads_per_worker"])


def configure_insightface_onnxruntime() -> None:
    """Apply the server-side inference scheduling policy for ONNX Runtime."""
    global _PATCHED

    if _PATCHED:
        return

    try:
        import onnxruntime as ort
        import insightface.model_zoo.model_zoo as model_zoo
    except Exception:
        return

    original_init = model_zoo.PickableInferenceSession.__init__
    inference_threads = automatic_inference_threads()

    def configured_init(self, model_path, **kwargs):
        if kwargs.get("sess_options") is None:
            sess_options = ort.SessionOptions()
            sess_options.intra_op_num_threads = inference_threads
            try:
                sess_options.add_session_config_entry("session.intra_op.allow_spinning", "0")
                sess_options.add_session_config_entry("session.inter_op.allow_spinning", "0")
            except Exception:
                pass
            kwargs["sess_options"] = sess_options
        return original_init(self, model_path, **kwargs)

    model_zoo.PickableInferenceSession.__init__ = configured_init
    _PATCHED = True
    print(f"[ONNX] CPU scheduling=balanced, inference_threads={inference_threads}, spinning=off")
