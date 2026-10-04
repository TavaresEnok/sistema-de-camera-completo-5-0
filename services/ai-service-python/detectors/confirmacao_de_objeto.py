"""Confirmação de objeto por PERSISTÊNCIA — o que separa alarme de ruído.

O DEFEITO QUE ISTO CORRIGE
--------------------------
Até 10/08/2026 um único quadro acima do limiar de confiança já virava evento.
Bastava um arbusto no vento, um reflexo ou uma sombra parecerem uma pessoa por
1/4 de segundo para o cliente receber um alarme. O único freio era um debounce
de TEMPO, que atrasa o próximo alarme mas não questiona o primeiro.

Num sistema de segurança isso é pior do que parece: alarme que toca à toa
ensina o operador a ignorar o painel, e aí o alarme verdadeiro também é
ignorado.

COMO O FRIGATE RESOLVE, E POR QUE COPIAMOS ESSA IDEIA
-----------------------------------------------------
Dois estágios, com papéis diferentes:

  · `min_score` (por quadro, baixo)  → deixa a detecção ENTRAR no rastreamento.
    Serve para desenhar a caixa na tela e para o rastreador manter identidade.
  · `threshold` (agregado, alto)     → só então o objeto vira EVENTO.

O agregado é a MEDIANA das confianças do objeto ao longo da vida dele, não a
média: um único quadro espúrio em 0,99 não arrasta a mediana, enquanto
arrastaria a média. É exatamente o caso que se quer descartar.

Mantemos o limiar por quadro BAIXO de propósito. Subi-lo cortaria a caixa na
tela ao vivo e a identidade do rastreador — é melhor ver e rastrear muito, e
ser exigente só na hora de acordar alguém.

UM EVENTO POR OBJETO
--------------------
Uma pessoa que fica dez minutos no pátio é UM evento, não dois mil. A
confirmação dispara uma única vez por faixa de rastreamento; o debounce de
tempo que já existia continua valendo como segunda rede.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field


@dataclass(frozen=True)
class PoliticaDeConfirmacao:
    """Quando um objeto rastreado passa a ser digno de acordar alguém."""

    # Quantos quadros o objeto precisa aparecer antes de poder confirmar.
    # O Frigate usa metade do fps de detecção; com 4 fps isso daria 2. Usamos 3
    # por sermos um pouco mais exigentes: o custo de esperar mais um quadro é
    # ~0,25 s, e o custo de um alarme falso é a confiança do operador.
    minimo_de_quadros: int = 3

    # Mediana mínima das confianças para virar evento. É o `threshold` do
    # Frigate (0,7). Bem acima do limiar por quadro, de propósito.
    limiar_mediana: float = 0.70

    # Depois de quantos quadros sem ver o objeto ele é esquecido. Com 4 fps,
    # 20 quadros ≈ 5 s — tempo de alguém passar atrás de um poste sem que a
    # faixa seja descartada e recomeçada do zero.
    esquecer_apos_faltas: int = 20

    # Janela deslizante de confianças por faixa. Sem isto, um objeto parado por
    # horas acumularia memória sem fim; e a mediana de uma janela recente
    # responde melhor a uma cena que mudou.
    janela_de_confiancas: int = 30

    # Teto de faixas simultâneas em memória. Cena movimentada não pode virar
    # vazamento de memória num serviço que roda por semanas.
    maximo_de_faixas: int = 256


@dataclass
class _Faixa:
    confiancas: list[float] = field(default_factory=list)
    quadros: int = 0
    faltas: int = 0
    confirmada: bool = False
    ultima_ordem: int = 0


class ConfirmadorDeObjeto:
    """Decide quais detecções rastreadas viram evento.

    Uso, uma vez por quadro:

        confirmadas = confirmador.avaliar(deteccoes)

    Devolve APENAS as detecções que acabaram de ser confirmadas — as que já
    tinham sido, e as que ainda não têm evidência, ficam de fora.
    """

    def __init__(self, politica: PoliticaDeConfirmacao | None = None):
        self.politica = politica or PoliticaDeConfirmacao()
        self._faixas: dict[object, _Faixa] = {}
        self._ordem = 0

    # ── API ─────────────────────────────────────────────────────────────────
    def avaliar(self, deteccoes) -> list:
        """Atualiza o estado com o quadro atual e devolve o que virou evento."""
        self._ordem += 1
        vistas: set[object] = set()
        confirmadas = []

        for deteccao in deteccoes or []:
            chave = self._chave(deteccao)
            extra = getattr(deteccao, "extra", None) or {}
            if extra.get("estimated") or extra.get("observedByModel") is False:
                # Estimates keep an existing ID alive but are not new evidence.
                if chave is not None and chave in self._faixas:
                    vistas.add(chave)
                continue
            if chave is None:
                # Sem identidade entre quadros não há como exigir persistência.
                # Deixa passar para NÃO piorar o que já existia — o caminho de
                # objeto tem rastreamento; quem não tem é caso à parte.
                confirmadas.append(deteccao)
                continue

            vistas.add(chave)
            faixa = self._faixas.get(chave)
            if faixa is None:
                faixa = _Faixa()
                self._faixas[chave] = faixa

            faixa.quadros += 1
            faixa.faltas = 0
            faixa.ultima_ordem = self._ordem
            faixa.confiancas.append(float(getattr(deteccao, "confidence", 0.0) or 0.0))
            if len(faixa.confiancas) > self.politica.janela_de_confiancas:
                del faixa.confiancas[0]

            if faixa.confirmada:
                continue  # uma pessoa parada dez minutos é UM evento, não dois mil
            if faixa.quadros < self.politica.minimo_de_quadros:
                continue
            if statistics.median(faixa.confiancas) < self.politica.limiar_mediana:
                continue

            faixa.confirmada = True
            confirmadas.append(deteccao)

        self._contar_faltas(vistas)
        self._limitar()
        return confirmadas

    def estado(self) -> dict:
        """Números para diagnóstico (aparecem no status do serviço)."""
        return {
            "faixas": len(self._faixas),
            "confirmadas": sum(1 for f in self._faixas.values() if f.confirmada),
            "aguardando_evidencia": sum(1 for f in self._faixas.values() if not f.confirmada),
        }

    def confirmed_track_ids(self) -> set:
        """Read by the owning camera loop; never replace real confirmation hits."""
        return {key for key, faixa in self._faixas.items() if faixa.confirmada}

    # ── Interno ─────────────────────────────────────────────────────────────
    @staticmethod
    def _chave(deteccao):
        extra = getattr(deteccao, "extra", None) or {}
        track = extra.get("trackId")
        return None if track is None else track

    def _contar_faltas(self, vistas: set) -> None:
        for chave, faixa in list(self._faixas.items()):
            if chave in vistas:
                continue
            faixa.faltas += 1
            if faixa.faltas > self.politica.esquecer_apos_faltas:
                del self._faixas[chave]

    def _limitar(self) -> None:
        """Teto de memória: descarta as faixas vistas há mais tempo.

        Roda DEPOIS da inserção — o contrário deixaria passar uma a mais e o
        teto seria uma sugestão, não um teto. (Mesma armadilha já corrigida no
        detector de travessia.)
        """
        excedente = len(self._faixas) - self.politica.maximo_de_faixas
        if excedente <= 0:
            return
        mais_antigas = sorted(self._faixas.items(), key=lambda par: par[1].ultima_ordem)
        for chave, _ in mais_antigas[:excedente]:
            del self._faixas[chave]
