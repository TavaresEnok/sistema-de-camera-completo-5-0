import time
from collections import Counter, deque

import cv2
import numpy as np

from .base import Detection, Detector
from .illumination_guard import GlobalIlluminationGuard, IlluminationDecision
from .motion_contrast import stretch_lut, uint8_percentile
from runtime_profiles import MOTION_PROFILE


# ── NÍVEIS DE SENSIBILIDADE POR ZONA ────────────────────────────────────────
# Grade de sensibilidade do Bluecherry (`thresholds[768]`, 32x24, mapa
# {255,48,26,12,7,3}), adaptada: o nível viaja na PRÓPRIA zona em vez de numa
# segunda geometria, então reaproveita a tela de perímetro que já existe.
#
# O fator multiplica a ÁREA MÍNIMA exigida do objeto naquela região. Com
# máscara binária o operador só tinha "vigia" ou "ignora": uma árvore que
# balança obrigava a escolher entre gravar folha o dia inteiro ou abrir um
# ponto CEGO (e perder quem passasse atrás dela). Com nível, a árvore apenas
# exige um objeto maior.
_FATOR_POR_NIVEL = (0.5, 1.0, 3.0)          # alta, media, baixa
_NIVEL_POR_NOME = {"alta": 0, "media": 1, "média": 1, "baixa": 2}
_NIVEL_PADRAO = 1                            # media = comportamento de sempre


class MotionDetector(Detector):
    """Detector de movimento leve (MOG2), calibrado para se aproximar da
    sensibilidade da detecção nativa das câmeras (validada em campo 2026-07-21):

    - COMPONENTES CONECTADOS em vez de contagem bruta de pixels: dispara quando
      UM objeto coeso ultrapassa um limiar PROPORCIONAL à imagem (~0,12% por
      padrão ≈ pessoa/moto distante), em vez de exigir 3% da tela somados —
      que ignorava tudo que não estivesse grande e perto. Ruído disperso
      (chuva/insetos/compressão) não forma componente grande e não dispara.
    - MUDANÇA GLOBAL DE CENA: troca dia/noite (IR), exposição automática,
      relâmpago, farol varrendo ou câmera reposicionada mudam a cena inteira de
      uma vez. O fundo é RECALIBRADO — mas o evento CONTINUA sendo reportado,
      marcado com sceneChange=true. Técnica derivada do Frigate (MIT) —
      Copyright (c) Frigate, Inc. — que recalibra sem parar de reportar
      (`lightning_threshold`), justamente porque descartar aqui apagaria a
      gravação no instante em que alguém acendeu a luz. Quem decide suprimir é
      a camada de cima; o gatilho da gravação não pode ser engolido.
    - SOMBRAS: MOG2 com detectShadows=True e pixels de sombra (127) descartados
      antes da análise — sombra projetada não vira movimento.
    - VIA RÁPIDA: região grande e compacta pode confirmar em 1 frame; regiões
      menos fortes continuam exigindo 2 ou 3 frames para filtrar ruído.
    - TODAS AS CAIXAS: devolve um Detection por objeto coeso (maior primeiro,
      com teto), não só o maior. Quem lê apenas o [0] continua vendo o mesmo de
      sempre; a confirmação semântica passa a enxergar a pessoa que entrou ao
      lado da árvore que balança (a árvore é a MAIOR caixa, não a relevante).
    """

    event_type = "MOTION_DETECTED"



    # varThreshold do MOG2 é comparado com a soma dos desvios de TODOS os canais.
    # Em 3 canais (BGR) a distância acumula 3 vezes; no plano Y (1 canal) ela cai,
    # e manter 40 tornaria o caminho novo MENOS sensível — objeto real deixaria de
    # disparar (= câmera deixa de gravar). Medido em cena sintética com ruído de
    # sensor (bench de calibração, 2026-07-27): com objeto de baixo contraste
    # (delta 12 sobre ruído sigma 5) o BGR/40 dispara (114 px) e o Y/40 NÃO
    # dispara (0 px); Y/20 dispara (153 px) e acompanha o BGR em sigma 1..10 sem
    # criar falso positivo em cena parada (0 px nos dois). Daí o par 40/20.
    _VAR_THRESHOLD_BGR = 40
    _VAR_THRESHOLD_LUMA = 20

    def __init__(self, cfg: dict | None = None, zones: list | None = None):
        self.frame_width = int(MOTION_PROFILE["analysis_width"])
        self.frame_height = int(MOTION_PROFILE["analysis_height"])
        # Máscara de zonas (0/255) na resolução de ANÁLISE. None = câmera inteira.
        self._zones = zones or []
        self._zone_mask = self._build_zone_mask(self._zones)
        self._zone_factor_map = self._build_zone_factor_map(self._zones)
        frame_area = float(self.frame_width * self.frame_height)
        # Limiar por OBJETO (componente conectado), proporcional à área analisada.
        self.min_component_pixels = max(
            12, int(frame_area * float(MOTION_PROFILE["motion_min_component_ratio"]))
        )
        self._test_excluded_masks = self._build_test_excluded_masks(self._zones)
        self._test_ignored_hits = 0
        self._test_ignored_motion = None
        # Acima desta fração da tela mudada de uma vez = alteração global (não é movimento).
        self.global_change_pixels = int(
            frame_area * float(MOTION_PROFILE["motion_global_change_ratio"])
        )
        self.fgbg = None
        # Warm-up: MOG2 aprende o fundo com taxa alta para eliminar fantasmas.
        self._warmup_frames = 0
        self._warmup_total = int(MOTION_PROFILE["motion_warmup_frames"])
        # Re-warmup curto após reset por mudança global (cena nova ≠ boot do zero).
        self._rewarmup_total = max(4, int(self._warmup_total // 3))
        self._consecutive_hits = 0
        self._min_consecutive = int(MOTION_PROFILE.get("motion_min_consecutive_hits", 3))
        self._fast_min_consecutive = max(1, self._min_consecutive - 1)
        self._single_frame_strong = bool(MOTION_PROFILE.get("motion_single_frame_strong", True))
        # Normalização de contraste (padrão Frigate): estica o histograma entre os
        # percentis 4–96, suavizado por média móvel — crucial à noite/baixa luz,
        # quando a imagem "achata" e o diff perde amplitude.
        self._improve_contrast = bool(MOTION_PROFILE.get("motion_improve_contrast", True))
        # Janela da suavização anterior ao MOG2 (ímpar; 0 desliga). Ver o bloco
        # grande em `infer` para o porquê e os números medidos.
        self._blur_ksize = int(MOTION_PROFILE.get("motion_blur_ksize", 3))
        if self._blur_ksize and self._blur_ksize % 2 == 0:
            self._blur_ksize += 1  # GaussianBlur exige janela ímpar
        # Nuvem/luz/exposicao: remove deslocamento GLOBAL de luminancia antes do
        # MOG2, preservando o residuo LOCAL de uma pessoa/veiculo.
        self._illumination_enabled = bool(MOTION_PROFILE.get("motion_illumination_compensation", True))
        self._photometric_scene_suppression = bool(
            MOTION_PROFILE.get("motion_photometric_scene_suppression", True)
        )
        self._illumination = None
        self._illumination_config = {
            "min_shift": float(MOTION_PROFILE.get("motion_illumination_min_shift", 8.0)),
            "residual_threshold": float(MOTION_PROFILE.get("motion_illumination_residual_threshold", 10.0)),
            "uniform_ratio": float(MOTION_PROFILE.get("motion_illumination_uniform_ratio", 0.72)),
            "block_uniform_ratio": float(MOTION_PROFILE.get("motion_illumination_block_uniform_ratio", 0.75)),
            "alpha": float(MOTION_PROFILE.get("motion_illumination_alpha", 0.02)),
            "recovery_alpha": float(MOTION_PROFILE.get("motion_illumination_recovery_alpha", 0.02)),
        }
        self._last_illumination = IlluminationDecision()
        self._stats = Counter()
        self._last_suppression_reason = None
        self._contrast_history = np.zeros((50, 2), dtype=np.float32)
        self._contrast_history[:, 1] = 255.0
        self._contrast_index = 0
        self._contrast_initialized = False
        # Preservação de quem FICA na cena (padrão Frigate): enquanto o movimento
        # é recente, o fundo NÃO aprende (pessoa parada não é "engolida" e some);
        # só depois de persistir é que a mudança começa a ser absorvida (carro
        # estacionado vira fundo aos poucos, como deve ser).
        self._motion_streak = 0
        self._freeze_learning_frames = int(MOTION_PROFILE.get("motion_freeze_learning_frames", 6))
        # Mudança global de cena: reportar (padrão) ou voltar a engolir o evento
        # como antes (kill-switch MOTION_SCENE_CHANGE_REPORT=false).
        self._scene_change_report = bool(MOTION_PROFILE.get("motion_scene_change_report", True))
        # Plano de luminância em vez de BGR (MOTION_LUMA_PLANE=true). OPT-IN: o
        # padrão continua sendo o caminho de hoje, com o BGR inteiro.
        self._luma_plane = bool(MOTION_PROFILE.get("motion_luma_plane", False))
        # Teto de caixas devolvidas por frame (a lista não pode explodir numa
        # cena agitada: cada caixa vira um recorte na confirmação semântica).
        self._max_boxes = max(1, int(MOTION_PROFILE.get("motion_max_boxes", 4)))
        # Piso de ruído adaptativo (ver o bloco em `infer`). A janela é medida em
        # QUADROS analisados: a 2 fps, 60 quadros ≈ 30 s de história — tempo
        # suficiente para "o vento está soprando" virar tendência, e curto o
        # bastante para o piso descer quando ele passa.
        self._noise_floor_enabled = bool(MOTION_PROFILE.get("motion_noise_floor", True))
        self._noise_window = deque(maxlen=max(10, int(MOTION_PROFILE.get("motion_noise_window", 60))))
        self._noise_floor_factor = float(MOTION_PROFILE.get("motion_noise_floor_factor", 1.6))
        # Supressão de atividade crônica (luz piscando/bandeira/água). Construída
        # preguiçosamente no 1º quadro, quando a resolução de análise é conhecida.
        # Ver detectors/chronic_activity.py.
        self._chronic_enabled = bool(MOTION_PROFILE.get("motion_chronic_suppression", True))
        self._chronic_alpha = float(MOTION_PROFILE.get("motion_chronic_alpha", 0.02))
        self._chronic_threshold = float(MOTION_PROFILE.get("motion_chronic_threshold", 0.45))
        self._chronic_warmup = int(MOTION_PROFILE.get("motion_chronic_warmup", 60))
        self._chronic = None
        # Descarte de disparo periódico (ver detectors/periodicity.py). Cobre a
        # lacuna do mapa crônico: luz de piscada LENTA tem atividade baixa e
        # escapa por lá, mas o relógio dela a entrega aqui.
        self._periodic_enabled = bool(MOTION_PROFILE.get("motion_periodic_suppression", True))
        self._periodic_cells = int(MOTION_PROFILE.get("motion_periodic_cells", 8))
        self._periodic_min_samples = int(MOTION_PROFILE.get("motion_periodic_min_samples", 6))
        self._periodic_cv_max = float(MOTION_PROFILE.get("motion_periodic_cv_max", 0.15))
        self._periodic = None

    def _build_zone_factor_map(self, zones: list | None):
        """Mapa de NÍVEL DE SENSIBILIDADE por pixel (0..len(_FATOR_POR_NIVEL)-1).

        Ideia portada do Bluecherry, que mantém uma grade 32×24 com um limiar
        por célula em vez de uma máscara liga/desliga. Adaptamos ao que já
        existe aqui: o nível viaja na PRÓPRIA zona (`sensitivity`), então não é
        preciso inventar uma segunda geometria nem uma tela nova para pintá-la.

        Por que importa: com máscara binária o operador só tem "vigia" ou
        "ignora". Uma árvore que balança obriga a escolher entre gravar folha o
        dia inteiro ou criar um ponto CEGO — e quem passa atrás da árvore some.
        Com nível, a árvore só exige um objeto maior para disparar: folha para
        de gravar, pessoa continua sendo vista.

        Retorna None quando toda a área está no nível padrão — assim quem não
        usa o recurso não paga nada (nem memória, nem a busca por componente).
        """
        if not zones:
            return None
        try:
            padrao = _NIVEL_PADRAO
            mapa = np.full((self.frame_height, self.frame_width), padrao, dtype=np.uint8)
            algum = False
            for zone in zones:
                if str(zone.get("kind", "exclude")) not in ("include", "exclude"):
                    continue
                nivel = _NIVEL_POR_NOME.get(str(zone.get("sensitivity", "")).strip().lower())
                if nivel is None or nivel == padrao:
                    continue
                poly = self._zona_para_poligono(zone)
                if poly is None:
                    continue
                cv2.fillPoly(mapa, [poly], int(nivel))
                algum = True
            return mapa if algum else None
        except Exception:
            return None  # sensibilidade malformada nunca pode cegar a câmera

    def _zona_para_poligono(self, zone):
        pts = zone.get("points") or []
        arr = [
            [
                int(max(0.0, min(1.0, float(p[0]))) * (self.frame_width - 1)),
                int(max(0.0, min(1.0, float(p[1]))) * (self.frame_height - 1)),
            ]
            for p in pts
            if isinstance(p, (list, tuple)) and len(p) >= 2
        ]
        return np.array(arr, dtype=np.int32) if len(arr) >= 3 else None

    def _build_zone_mask(self, zones: list | None):
        """Converte polígonos normalizados (0..1) numa máscara binária.

        - `exclude`: recortado da área monitorada.
        - `include`: havendo ao menos um, só o interior deles é monitorado.
        Retorna None quando não há zonas (câmera inteira — caminho mais rápido,
        sem custo nenhum para quem não usa o recurso).
        """
        if not zones:
            return None
        try:
            includes = [z for z in zones if str(z.get("kind", "exclude")) == "include"]
            excludes = [z for z in zones if str(z.get("kind", "exclude")) == "exclude"]
            if not includes and not excludes:
                return None

            def to_polygon(zone):
                pts = zone.get("points") or []
                arr = [
                    [
                        int(max(0.0, min(1.0, float(p[0]))) * (self.frame_width - 1)),
                        int(max(0.0, min(1.0, float(p[1]))) * (self.frame_height - 1)),
                    ]
                    for p in pts
                    if isinstance(p, (list, tuple)) and len(p) >= 2
                ]
                return np.array(arr, dtype=np.int32) if len(arr) >= 3 else None

            # Base: tudo monitorado, salvo se houver zonas de inclusão.
            mask = np.full((self.frame_height, self.frame_width), 0 if includes else 255, dtype=np.uint8)
            for zone in includes:
                poly = to_polygon(zone)
                if poly is not None:
                    cv2.fillPoly(mask, [poly], 255)
            for zone in excludes:
                poly = to_polygon(zone)
                if poly is not None:
                    cv2.fillPoly(mask, [poly], 0)
            # Máscara totalmente vazia seria "câmera cega": trata como sem zonas.
            return mask if int(np.count_nonzero(mask)) > 0 else None
        except Exception:
            return None  # zona malformada nunca pode cegar a câmera

    def set_zones(self, zones: list | None) -> None:
        self._zones = zones or []
        self._zone_mask = self._build_zone_mask(self._zones)
        self._zone_factor_map = self._build_zone_factor_map(self._zones)
        self._test_excluded_masks = self._build_test_excluded_masks(self._zones)
        self._test_ignored_hits = 0
        self._test_ignored_motion = None
        # A referencia fotometrica foi aprendida sob outra area monitorada.
        # Recriar evita que uma troca de zona pareca uma mudanca de luz.
        self._illumination = None

    def _build_test_excluded_masks(self, zones):
        masks = []
        for zone in zones or []:
            if zone.get("kind") != "exclude":
                continue
            polygon = self._zona_para_poligono(zone)
            if polygon is None:
                continue
            mask = np.zeros((self.frame_height, self.frame_width), dtype=np.uint8)
            cv2.fillPoly(mask, [polygon], 255)
            area = int(np.count_nonzero(mask))
            if area >= self.min_component_pixels:
                masks.append((str(zone.get("name") or "área ignorada"), mask, area))
        return masks

    def _observe_ignored_motion(self, raw_mask) -> None:
        # Diagnóstico temporário, só enquanto o operador testa o perímetro.
        # Não altera a máscara nem os alarmes reais do detector.
        if not self._test_excluded_masks:
            return
        cleaned = cv2.morphologyEx(raw_mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        global_limit = int(self.frame_width * self.frame_height * 0.65)
        if int(np.count_nonzero(cleaned)) >= global_limit:
            self._test_ignored_hits = 0
            return
        hit = None
        for name, mask, area in self._test_excluded_masks:
            count = int(cv2.countNonZero(cv2.bitwise_and(cleaned, mask)))
            if count >= max(self.min_component_pixels, int(area * 0.01)):
                hit = name
                break
        self._test_ignored_hits = self._test_ignored_hits + 1 if hit else 0
        if hit and self._test_ignored_hits >= 2 and self._warmup_frames >= self._warmup_total_current:
            self._test_ignored_motion = {"zone": hit, "at": time.time()}

    def _effective_global_change_pixels(self) -> int:
        if self._zone_mask is None:
            return self.global_change_pixels
        monitored = int(np.count_nonzero(self._zone_mask))
        ratio = float(MOTION_PROFILE["motion_global_change_ratio"])
        return max(self.min_component_pixels * 4, int(monitored * ratio))

    def load(self) -> None:
        if self.fgbg is None:
            self._create_background(self._warmup_total)

    def _create_background(self, warmup_total: int) -> None:
        self.fgbg = cv2.createBackgroundSubtractorMOG2(
            history=300,        # Menos história = adapta mais rápido
            # Sensível a diferenças reais; escalado por nº de canais (ver constantes).
            varThreshold=self._VAR_THRESHOLD_LUMA if self._luma_plane else self._VAR_THRESHOLD_BGR,
            detectShadows=True,  # Sombras marcadas com 127 e DESCARTADAS abaixo
        )
        self._warmup_frames = 0
        self._warmup_total_current = warmup_total
        self._consecutive_hits = 0
        self._motion_streak = 0
        # Filtros aprendidos pertencem ao fundo anterior. Mantê-los depois de
        # IR/PTZ/mudança de cena poderia criar regiões cegas ou piso artificial.
        self._noise_window.clear()
        if self._chronic is not None:
            self._chronic.reiniciar()
        if self._periodic is not None:
            self._periodic.esquecer()

    def infer(self, frame, context_key: str | None = None, **kwargs) -> list[Detection]:
        if self.fgbg is None:
            self.load()

        self._stats["frames"] += 1
        self._last_suppression_reason = None
        small_frame = cv2.resize(frame, (self.frame_width, self.frame_height))

        raw_gray = cv2.cvtColor(small_frame, cv2.COLOR_BGR2GRAY) if small_frame.ndim == 3 else small_frame
        if self._illumination_enabled:
            if self._illumination is None:
                self._illumination = GlobalIlluminationGuard(
                    raw_gray.shape,
                    **self._illumination_config,
                )
            small_frame, self._last_illumination = self._illumination.compensate(
                small_frame,
                mask=self._zone_mask,
            )
            if self._last_illumination.photometric:
                self._stats["photometric_compensated_frames"] += 1
        else:
            self._last_illumination = IlluminationDecision()

        # PLANO DE LUMINÂNCIA (opt-in): a IA aqui é SÓ movimento, e movimento vive
        # na luminância — os dois canais de cor custam CPU no MOG2 sem mudar a
        # decisão em cena monocromática/noturna. O cinza já era calculado para o
        # contraste, então ligar a flag não acrescenta conversão nenhuma: apenas
        # passa 1 canal adiante em vez de 3. Cor NÃO é de graça, porém — objeto
        # que se distingue só por matiz (mesma luminância do fundo) some no plano
        # Y; por isso o padrão continua BGR e a troca é consciente, por câmera.
        gray_probe = None
        if self._luma_plane or self._improve_contrast:
            gray_probe = (
                cv2.cvtColor(small_frame, cv2.COLOR_BGR2GRAY) if small_frame.ndim == 3 else small_frame
            )
        if self._luma_plane:
            small_frame = gray_probe

        # Normalização de contraste antes do diff (média móvel evita "pulos").
        #
        # `uint8_percentile` e `stretch_lut` são substitutos BIT-EXATOS do
        # `np.percentile` + esticamento em float32 que estavam aqui — a etapa
        # respondia por ~52% do custo por frame (mais que o próprio MOG2), toda
        # ela em ordenar 57.600 elementos para extrair dois números e em alocar
        # buffers float32 para uma função de apenas 256 respostas possíveis.
        # A equivalência é travada por tests/test_motion_contrast_fastpath.py:
        # sem ela, a sensibilidade de TODAS as câmeras mudaria em silêncio.
        if self._improve_contrast:
            lo = uint8_percentile(gray_probe, 4)
            hi = uint8_percentile(gray_probe, 96)
            # Seed once before background learning. A uniform first scene uses
            # the identity transform: reseeding later when an object appears
            # would turn that local movement into an artificial global change.
            if not self._contrast_initialized:
                if hi > lo:
                    self._contrast_history[:] = (lo, hi)
                self._contrast_initialized = True
            if hi > lo:
                self._contrast_history[self._contrast_index] = (lo, hi)
                self._contrast_index = (self._contrast_index + 1) % len(self._contrast_history)
                avg_lo, avg_hi = self._contrast_history.mean(axis=0)
                if avg_hi > avg_lo + 1:
                    small_frame = stretch_lut(small_frame, float(avg_lo), float(avg_hi))

        # SUAVIZAÇÃO ANTES DO MODELO (lacuna encontrada ao comparar com o
        # Frigate, que aplica gaussian_filter sigma=1 no mesmo ponto).
        #
        # O MOG2 modela CADA PIXEL isoladamente, então ruído de sensor entra
        # direto como "primeiro plano": pixels espalhados que a morfologia
        # depois tenta limpar — tarde demais, porque já contaminaram a contagem
        # e o modelo de fundo. Suavizar ANTES faz o ruído de pixel único ser
        # absorvido pelos vizinhos, enquanto um objeto real (dezenas de pixels
        # coesos) sobrevive praticamente intacto.
        #
        # Medido no banco tests/bench_motion_ruido.py (cena PARADA com ruído de
        # sensor, 120 quadros; e objeto de baixo contraste atravessando):
        #   sigma 10 (câmera à noite/ganho alto): 90 falsos → 0, objeto real OK.
        # Ou seja: 75% dos quadros disparavam gravação por ruído puro.
        if self._blur_ksize >= 3:
            small_frame = cv2.GaussianBlur(small_frame, (self._blur_ksize, self._blur_ksize), 0)

        warmup_total = getattr(self, "_warmup_total_current", self._warmup_total)
        if self._warmup_frames < warmup_total:
            learning_rate = 0.1  # queima o fundo rápido nos primeiros frames
            self._warmup_frames += 1
        elif 0 < self._motion_streak <= self._freeze_learning_frames:
            learning_rate = 0.0  # movimento RECENTE: congela o fundo (não engole quem parou)
        else:
            learning_rate = -1  # modo automático estável

        fgmask = self.fgbg.apply(small_frame, learningRate=learning_rate)

        # Sombra (127) não é movimento; só primeiro plano pleno (255) conta.
        fgmask = np.where(fgmask == 255, np.uint8(255), np.uint8(0))
        if kwargs.get("perimeter_test"):
            self._observe_ignored_motion(fgmask)

        # Zonas: zera o que está fora da área monitorada ANTES de medir. Assim
        # árvore/rua excluídas não contam para movimento nem para a rejeição
        # global (senão vento numa árvore grande "apagaria" a cena inteira).
        if self._zone_mask is not None:
            fgmask = cv2.bitwise_and(fgmask, self._zone_mask)

        # Morfologia para eliminar ruído fino e unir fragmentos do mesmo objeto.
        kernel = np.ones((5, 5), np.uint8)
        fgmask = cv2.morphologyEx(fgmask, cv2.MORPH_OPEN, kernel)
        fgmask = cv2.morphologyEx(fgmask, cv2.MORPH_CLOSE, kernel)

        if self._warmup_frames < warmup_total:
            self._stats["warmup_suppressed_frames"] += 1
            self._last_suppression_reason = "warmup"
            return []  # aprendendo o fundo — não reporta

        # ── SUPRESSÃO DE ATIVIDADE CRÔNICA ──────────────────────────────────
        # Zera o que fica ativo perto de metade do tempo no MESMO ponto — luz
        # piscando, bandeira, água, folha ao vento. Aplicada AQUI, depois da
        # morfologia e ANTES de contar pixels/formar componentes, para o crônico
        # não inflar a contagem nem virar caixa. Movimento real cruza cada célula
        # por pouco tempo e passa intacto. Ver detectors/chronic_activity.py.
        #
        # Fica ANTES da checagem de mudança global (abaixo, via motion_pixels):
        # uma luz piscando não deve simular "cena mudou". Já uma mudança global
        # de verdade (luz da sala acende) atinge pixels que estavam ESTÁVEIS —
        # não crônicos — então não é suprimida.
        if self._chronic_enabled:
            if self._chronic is None:
                from .chronic_activity import SupressorDeAtividadeCronica
                self._chronic = SupressorDeAtividadeCronica(
                    fgmask.shape, alpha=self._chronic_alpha,
                    limiar=self._chronic_threshold, warmup=self._chronic_warmup,
                )
            before_chronic = int(np.count_nonzero(fgmask))
            fgmask = self._chronic.atualizar_e_suprimir(fgmask)
            chronic_removed = before_chronic - int(np.count_nonzero(fgmask))
            if chronic_removed > 0:
                self._stats["chronic_suppressed_frames"] += 1
                self._stats["chronic_suppressed_pixels"] += chronic_removed

        motion_pixels = int(np.count_nonzero(fgmask))

        # MUDANÇA GLOBAL (IR/exposição/relâmpago/câmera mexida): a cena inteira
        # muda de uma vez. Reaprende o fundo com warm-up curto para não disparar
        # no reajuste — MAS CONTINUA REPORTANDO. Engolir aqui significava não
        # gravar exatamente no instante em que a luz acendeu, que é quando algo
        # costuma estar acontecendo. O evento sai marcado (sceneChange=true) para
        # que a camada de cima possa classificá-lo; a gravação não se perde.
        # Com zonas, o limiar é proporcional à ÁREA MONITORADA (não à tela toda),
        # senão uma zona pequena jamais atingiria a fração de mudança global.
        if motion_pixels >= self._effective_global_change_pixels():
            components = self._largest_components(fgmask)
            photometric = bool(self._last_illumination.photometric)
            if self._illumination is not None:
                # A cena crua atual passa a ser a referencia da recuperacao.
                self._illumination.reset(raw_gray)
            self._create_background(self._rewarmup_total)
            self._stats["global_scene_changes"] += 1
            if photometric and self._photometric_scene_suppression:
                self._stats["photometric_scene_changes_suppressed"] += 1
                self._last_suppression_reason = "photometric_scene_change"
                return []
            if not self._scene_change_report:
                self._stats["scene_changes_suppressed"] += 1
                self._last_suppression_reason = "scene_change_policy"
                return []  # kill-switch: comportamento anterior (engole o evento)
            if not components:
                # A cena mudou inteira mas a morfologia não deixou componente
                # nenhum: reporta a área monitorada, nunca silêncio.
                components = [(motion_pixels, (0, 0, self.frame_width, self.frame_height))]
            # Sem confirmação temporal: a recalibração acabou de zerar o contador,
            # e exigir N frames iguais aqui é o mesmo que nunca reportar.
            self._stats["motion_emitted_frames"] += 1
            return self._build_detections(frame, components, motion_pixels, scene_change=True)

        # ── PISO DE RUÍDO ADAPTATIVO (ideia do Shinobi, `filterTheNoise`) ─────
        # O Shinobi guarda a média das últimas medidas de movimento e exige que
        # o disparo esteja ACIMA dela. Assim, em dia de vento o limiar sobe
        # sozinho, sem ninguém reconfigurar nada — e volta a descer quando o
        # vento passa.
        #
        # Usamos MEDIANA, não média: mediana é robusta a picos. Com média, uma
        # única pessoa atravessando a cena elevaria o piso e o detector ficaria
        # surdo logo depois — exatamente quando ela ainda está lá. Com mediana,
        # é preciso que MAIS DA METADE da janela esteja agitada para o piso
        # subir, que é a definição de "a cena está agitada", não "algo passou".
        self._noise_window.append(motion_pixels)
        piso = 0
        if self._noise_floor_enabled and len(self._noise_window) >= self._noise_window.maxlen:
            piso = int(np.median(self._noise_window) * self._noise_floor_factor)
        limiar_efetivo = max(self.min_component_pixels, piso)

        if motion_pixels < limiar_efetivo:
            if piso > self.min_component_pixels and motion_pixels >= self.min_component_pixels:
                self._stats["noise_floor_suppressed_frames"] += 1
                self._last_suppression_reason = "adaptive_noise_floor"
            self._consecutive_hits = 0
            self._motion_streak = 0
            return []

        # Componentes conectados: cada objeto coeso vira uma caixa (maior primeiro).
        components = self._largest_components(fgmask)
        if not components:
            self._consecutive_hits = 0
            self._motion_streak = 0
            return []

        # ── DESCARTE DE DISPARO PERIÓDICO ───────────────────────────────────
        # O que é MECÂNICO tem relógio: luz de aviso, letreiro, ventilador. O
        # mapa crônico acima só pega o que fica ativo boa parte do tempo — uma
        # luz que pisca DEVAGAR (a cada 8-10 s) tem atividade baixa e escapa por
        # ele. Aqui a região é julgada pela REGULARIDADE dos intervalos: gente é
        # irregular (chega, para, volta), máquina não.
        # Descartado componente a componente para não perder a pessoa que passa
        # ao lado da luz no mesmo quadro.
        if self._periodic_enabled and components:
            if self._periodic is None:
                from .periodicity import DetectorDePeriodicidade
                self._periodic = DetectorDePeriodicidade(
                    celulas=self._periodic_cells,
                    minimo_amostras=self._periodic_min_samples,
                    cv_maximo=self._periodic_cv_max,
                )
            agora = time.monotonic()
            restantes = [
                c for c in components
                if not self._periodic.e_periodico(c[1], self.frame_width, self.frame_height, agora)
            ]
            if not restantes:
                self._stats["periodic_suppressed_frames"] += 1
                self._stats["periodic_suppressed_components"] += len(components)
                self._last_suppression_reason = "periodic_activity"
                self._consecutive_hits = 0
                self._motion_streak = 0
                return []
            removed = len(components) - len(restantes)
            if removed:
                self._stats["periodic_suppressed_components"] += removed
            components = restantes

        best_area = components[0][0]

        # A brief pass can be present in only one of the sampled frames. Allow
        # that frame only for a large, dense region AFTER illumination, noise,
        # chronic activity, zones and periodicity guards. Do not bypass the
        # regular 2/3-frame policy for weak or scattered changes.
        self._motion_streak += 1
        self._consecutive_hits += 1
        _area, (x, y, w, h) = components[0]
        local_minimum = self.min_component_pixels
        if self._zone_factor_map is not None:
            local_level = int(np.max(self._zone_factor_map[y:y+h, x:x+w]))
            local_minimum *= _FATOR_POR_NIVEL[local_level]
        strong_single_frame = (
            self._single_frame_strong
            and not self._last_illumination.photometric
            and best_area >= max(local_minimum * 8, limiar_efetivo * 2)
            and best_area / max(1, w * h) >= 0.8
        )
        required = self._min_consecutive
        if best_area >= self.min_component_pixels * 6:
            required = self._fast_min_consecutive
        if strong_single_frame:
            required = 1
        if self._consecutive_hits < required:
            self._stats["temporal_suppressed_frames"] += 1
            self._last_suppression_reason = "temporal_confirmation"
            return []

        if strong_single_frame and self._consecutive_hits == 1:
            self._stats["strong_single_frame_confirmations"] += 1
        self._stats["motion_emitted_frames"] += 1
        return self._build_detections(frame, components, motion_pixels)

    def diagnostics(self) -> dict:
        """Estado explicavel para health/benchmark, sem expor imagens."""
        return {
            "engine": "opencv_mog2_hardened",
            "illumination_compensation": self._illumination_enabled,
            "photometric_scene_suppression": self._photometric_scene_suppression,
            "single_frame_strong": self._single_frame_strong,
            "last_suppression_reason": self._last_suppression_reason,
            "illumination": (
                self._illumination.diagnostics()
                if self._illumination is not None
                else {
                    "photometric": False,
                    "offset": 0.0,
                    "changed_ratio": 0.0,
                    "uniform_ratio": 0.0,
                    "block_uniform_ratio": 0.0,
                }
            ),
            "chronic_fraction": (
                round(self._chronic.fracao_cronica(), 6) if self._chronic is not None else 0.0
            ),
            "noise_floor_samples": len(self._noise_window),
            "perimeter_ignored_motion": self._test_ignored_motion,
            "counters": dict(self._stats),
        }

    def _largest_components(self, fgmask) -> list:
        """Componentes acima do limiar, do MAIOR para o menor, com teto.

        O maior continua sendo o primeiro — quem só lê [0] não percebe diferença.
        """
        num_labels, _labels, stats, centroides = cv2.connectedComponentsWithStats(fgmask, connectivity=8)
        found = []
        for label in range(1, num_labels):  # 0 = fundo
            area = int(stats[label, cv2.CC_STAT_AREA])
            # Limiar LOCAL: cada zona pode exigir mais (ou menos) área que o
            # padrão. É a resposta ao "ou vigia a árvore, ou apaga a árvore":
            # baixando a sensibilidade dela, folha ao vento para de gravar mas
            # pessoa passando ali continua disparando. Ver _build_zone_mask.
            exigido = self.min_component_pixels
            if self._zone_factor_map is not None:
                cx = min(self.frame_width - 1, max(0, int(centroides[label][0])))
                cy = min(self.frame_height - 1, max(0, int(centroides[label][1])))
                exigido = int(round(exigido * _FATOR_POR_NIVEL[int(self._zone_factor_map[cy, cx])]))
            if area < exigido:
                continue
            found.append(
                (
                    area,
                    (
                        int(stats[label, cv2.CC_STAT_LEFT]),
                        int(stats[label, cv2.CC_STAT_TOP]),
                        int(stats[label, cv2.CC_STAT_WIDTH]),
                        int(stats[label, cv2.CC_STAT_HEIGHT]),
                    ),
                )
            )
        # sort estável: em empate de área vence o menor label, como no varrimento
        # sequencial que existia aqui antes.
        found.sort(key=lambda item: -item[0])
        return found[: self._max_boxes]

    def _build_detections(self, frame, components: list, motion_pixels: int, scene_change: bool = False) -> list[Detection]:
        # bbox do objeto em coordenadas do frame ORIGINAL (overlay/diagnóstico).
        scale_x = frame.shape[1] / float(self.frame_width)
        scale_y = frame.shape[0] / float(self.frame_height)
        frame_area = float(self.frame_width * self.frame_height)
        boxes = [
            [int(x * scale_x), int(y * scale_y), int((x + w) * scale_x), int((y + h) * scale_y)]
            for _area, (x, y, w, h) in components
        ]

        detections: list[Detection] = []
        for index, ((area, _box), bbox) in enumerate(zip(components, boxes)):
            extra = {
                "value": area,
                "motionPixels": motion_pixels,
                "componentPixels": area,
                "componentRatio": round(area / frame_area, 5),
                "motionBoxIndex": index,
                "motionBoxCount": len(boxes),
                # ESPAÇO DA BBOX, declarado junto com ela. A bbox sai em
                # coordenadas do frame ORIGINAL (scale_x/scale_y acima), mas o
                # stream_processor não sabia disso e caía no fallback
                # `self.frame_width` (a largura de ANÁLISE, 320x180). O evento
                # gravado dizia "frameWidth 320, frameHeight 180" com bbox de
                # até y=228 — impossível — e quem desenha o overlay dividia
                # pelas dimensões erradas, jogando a caixa para ~2x a posição
                # real. Na tela, o movimento aparecia LONGE de onde aconteceu:
                # foi assim que uma zona funcionando pareceu ignorada
                # (relato do dono, 11/08/2026, Cam-09).
                "frameWidth": int(frame.shape[1]),
                "frameHeight": int(frame.shape[0]),
            }
            if index == 0 and len(boxes) > 1:
                # Quem consome só o primeiro Detection ainda enxerga a cena toda.
                extra["motionBoxes"] = boxes
            if scene_change:
                extra["sceneChange"] = True
            detections.append(
                Detection(
                    label="motion",
                    confidence=min(1.0, area / max(1.0, self.min_component_pixels * 8.0)),
                    bbox=bbox,
                    event_type=self.event_type,
                    extra=extra,
                )
            )
        return detections
