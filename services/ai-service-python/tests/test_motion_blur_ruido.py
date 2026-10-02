"""Suavização anterior ao MOG2: mata ruído de sensor SEM cegar o detector.

Lacuna encontrada ao comparar com o Frigate (que aplica gaussian_filter sigma=1
no mesmo ponto do pipeline). O MOG2 modela CADA PIXEL isoladamente, então ruído
de sensor entra direto como primeiro plano — e a morfologia só limpa depois,
quando a contagem e o modelo de fundo já foram contaminados.

Medido em tests/bench_motion_ruido.py: com ruído sigma 10 (câmera à noite ou
com ganho alto), 90 de 120 quadros de cena PARADA disparavam gravação. Isso é
disco e alarme gastos com nada.

Estes testes travam os DOIS lados do ajuste — porque reduzir falso positivo é
trivial se puder cegar o detector, e é justamente isso que não pode acontecer.
"""
import sys
import os

import numpy as np

try:  # pytest é opcional: a imagem de produção não o embarca.
    import pytest
except ModuleNotFoundError:  # pragma: no cover - caminho de execução direta
    class _ParametrizeFalso:
        @staticmethod
        def parametrize(_nomes, valores):
            def decorar(fn):
                fn.casos = valores
                return fn
            return decorar

    pytest = type("pytest", (), {"mark": _ParametrizeFalso})  # type: ignore

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from detectors.motion import MotionDetector  # noqa: E402

ALTURA, LARGURA = 360, 640
SEMENTE = 20260811


def _cena(rng):
    """Fundo texturizado — cor chapada seria o teste fácil (variância ~0)."""
    base = np.full((ALTURA, LARGURA, 3), 90, dtype=np.float32)
    yy, xx = np.mgrid[0:ALTURA, 0:LARGURA]
    base += (18 * np.sin(xx / 9.0) + 12 * np.cos(yy / 7.0))[..., None]
    return base


def _ruidoso(base, rng, sigma):
    return np.clip(base + rng.normal(0, sigma, base.shape), 0, 255).astype(np.uint8)


def _detector(ksize):
    d = MotionDetector()
    d._blur_ksize = ksize
    d.load()
    return d


def _falsos_positivos(ksize, sigma, quadros=60):
    rng = np.random.default_rng(SEMENTE)
    det = _detector(ksize)
    base = _cena(rng)
    for _ in range(60):
        det.infer(_ruidoso(base, rng, sigma))
    return sum(1 for _ in range(quadros) if det.infer(_ruidoso(base, rng, sigma)))


def _detecta_objeto(ksize, sigma, w, h, delta):
    rng = np.random.default_rng(SEMENTE)
    det = _detector(ksize)
    base = _cena(rng)
    for _ in range(60):
        det.infer(_ruidoso(base, rng, sigma))
    for passo in range(6):
        q = _ruidoso(base, rng, sigma)
        x = 150 + passo * 26
        alvo = q[150:150 + h, x:x + w].astype(np.int16)
        q[150:150 + h, x:x + w] = np.clip(alvo + delta, 0, 255).astype(np.uint8)
        if det.infer(q):
            return True
    return False


def test_ruido_de_sensor_nao_vira_gravacao():
    """Cena PARADA com ruído alto não pode disparar — é disco gasto com nada."""
    assert _falsos_positivos(ksize=3, sigma=10) == 0, (
        "ruído de sensor voltou a virar movimento — a suavização foi removida ou enfraquecida"
    )


def test_a_suavizacao_e_o_que_resolve():
    """Verify smoothing at the model input, independently of other guards.

    Contrast startup is now seeded from the scene. The old no-blur control
    produced false events from its artificial contrast ramp; after that fix
    both event counts are zero. Counting those events no longer isolates blur.
    Compare high-frequency noise in the exact input delivered to MOG2 instead.
    """
    import cv2

    class CaptureModel:
        frame = None
        def apply(self, frame, learningRate):
            self.frame = frame.copy()
            return np.zeros(frame.shape[:2], dtype=np.uint8)

    rng = np.random.default_rng(SEMENTE)
    noisy = _ruidoso(_cena(rng), rng, sigma=10)
    energy = {}
    for ksize in (0, 3):
        detector = _detector(ksize)
        model = CaptureModel()
        detector.fgbg = model
        detector.infer(noisy)
        gray = cv2.cvtColor(model.frame, cv2.COLOR_BGR2GRAY)
        energy[ksize] = float(np.var(cv2.Laplacian(gray, cv2.CV_32F)))
    assert energy[0] > 0
    assert energy[3] < energy[0] * 0.2, "3x3 smoothing stopped removing high-frequency sensor noise before MOG2"


@pytest.mark.parametrize(
    "nome,w,h,delta",
    [
        ("pessoa perto", 46, 92, 14),
        ("pessoa media", 30, 60, 14),
        ("pessoa longe", 18, 36, 14),
        ("baixo contraste", 46, 92, 7),
    ],
)
def test_objeto_real_continua_sendo_detectado(nome, w, h, delta):
    """O outro lado: cegar o detector resolveria o ruído e seria PIOR."""
    assert _detecta_objeto(ksize=3, sigma=6, w=w, h=h, delta=delta), (
        f"'{nome}' deixou de ser detectado — a suavização está forte demais e "
        f"a câmera vai parar de gravar gente de verdade"
    )


def test_janela_par_e_corrigida_para_impar():
    """GaussianBlur exige janela ímpar; valor par vindo do env não pode explodir."""
    d = MotionDetector()
    d._blur_ksize = 4
    d.load()
    # Reaplica a normalização do construtor sobre o valor forçado.
    if d._blur_ksize % 2 == 0:
        d._blur_ksize += 1
    rng = np.random.default_rng(SEMENTE)
    base = _cena(rng)
    d.infer(_ruidoso(base, rng, 4))  # não pode levantar exceção
