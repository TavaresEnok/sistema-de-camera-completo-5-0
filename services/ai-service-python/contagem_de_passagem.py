"""Contagem de passagem por linha virtual.

A linha de CONTAGEM usa a mesma geometria do tripwire (detectors/tripwire.py),
mas não vira alerta: cada travessia confirmada soma 1 em "entrada" ou "saída",
agrupada por minuto, e um envio periódico leva os totais para a API.

Três decisões que definem a confiabilidade do número:

1. **Tremor na linha não conta duas vezes.** Uma pessoa parada em cima da faixa
   pode "cruzar" e "voltar" em menos de um segundo. A travessia fica PENDENTE
   por `ESPERA_S`; se o mesmo objeto cruzar de volta nesse intervalo, as duas
   se anulam. Só depois da espera ela é contada.

2. **O mesmo objeto não entra duas vezes seguidas.** Sem sair, ninguém entra de
   novo: uma segunda "entrada" do mesmo trackId na mesma linha é descartada.

3. **Envio idempotente e seguro a reinício.** O que vai para a API é o TOTAL
   ABSOLUTO de cada minuto desta sessão do processador. Repetir o envio não
   duplica (a API grava com SET). A sessão (`sessao`) entra na chave: se a IA
   reiniciar no meio de um minuto, a nova sessão começa do zero sem apagar o que
   a anterior já enviou.
"""

from __future__ import annotations

import calendar
import logging
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

from object_policy import normalizar_classe

logger = logging.getLogger("ai-service.contagem")

ESPERA_S = 1.5
ESQUECER_OBJETO_S = 120.0
INTERVALO_DE_ENVIO_S = 30.0
# Minuto fechado e já enviado sai da memória depois deste tempo.
GUARDAR_MINUTO_S = 180.0
# Teto de minutos pendentes: API fora do ar por muito tempo não pode virar
# vazamento de memória. Cerca de 6 h de uma linha com os dois sentidos.
MAX_BALDES = 2000
QUADROS_PERMITIDOS = (5, 8, 12)


def quadros_de_contagem(valor: Any) -> Optional[int]:
    """Valida a taxa pedida para a câmera. Só aceita as opções da tela."""
    try:
        numero = int(valor)
    except (TypeError, ValueError):
        return None
    return numero if numero in QUADROS_PERMITIDOS else None


def direcao_da_travessia(sentido: str, entrada: str) -> str:
    """'in' quando o objeto cruzou no sentido marcado como entrada."""
    return "in" if sentido == entrada else "out"


def _minuto(epoch: float) -> int:
    return int(epoch // 60) * 60


Chave = Tuple[int, str, str, str]  # (minuto, linhaId, classe, direcao)


class ContadorDePassagem:
    def __init__(self, sessao: Optional[str] = None) -> None:
        self.sessao = sessao or uuid.uuid4().hex
        self._lock = threading.Lock()
        # (objeto, linha) -> (direcao, quando, nome, classe)
        self._pendentes: Dict[Tuple[str, str], Tuple[str, float, str, str]] = {}
        # (objeto, linha) -> (última direção contada, quando)
        self._ultima: Dict[Tuple[str, str], Tuple[str, float]] = {}
        self._baldes: Dict[Chave, int] = {}
        self._nomes: Dict[str, str] = {}
        self._sujos: set = set()
        self._enviado_em: Dict[Chave, float] = {}
        self.total_entradas = 0
        self.total_saidas = 0
        self.anuladas = 0
        self.repetidas = 0

    def registrar(self, travessia: Dict[str, Any], agora: Optional[float] = None) -> None:
        """Recebe uma travessia de linha de contagem já confirmada pelo tripwire."""
        agora = time.time() if agora is None else agora
        linha = str(travessia.get("linhaId") or "")
        objeto = f"{travessia.get('label') or '?'}:{travessia.get('trackId')}"
        direcao = travessia.get("direcao")
        if not linha or direcao not in ("in", "out"):
            return
        classe = normalizar_classe(travessia.get("label")) or "person"
        nome = str(travessia.get("linhaNome") or "Linha")
        chave = (objeto, linha)
        with self._lock:
            self._consolidar(agora)
            pendente = self._pendentes.get(chave)
            if pendente is not None:
                if pendente[0] != direcao:
                    # Cruzou e voltou dentro da espera: tremor, não passagem.
                    del self._pendentes[chave]
                    self.anuladas += 1
                return
            ultima = self._ultima.get(chave)
            if ultima is not None and ultima[0] == direcao:
                self.repetidas += 1
                return
            self._pendentes[chave] = (direcao, agora, nome, classe)

    def _consolidar(self, agora: float) -> None:
        for chave, (direcao, quando, nome, classe) in list(self._pendentes.items()):
            if agora - quando < ESPERA_S:
                continue
            del self._pendentes[chave]
            self._ultima[chave] = (direcao, quando)
            linha = chave[1]
            self._nomes[linha] = nome
            balde: Chave = (_minuto(quando), linha, classe, direcao)
            self._baldes[balde] = self._baldes.get(balde, 0) + 1
            self._sujos.add(balde)
            if direcao == "in":
                self.total_entradas += 1
            else:
                self.total_saidas += 1
        for chave in [k for k, (_, t) in self._ultima.items() if agora - t > ESQUECER_OBJETO_S]:
            del self._ultima[chave]
        if len(self._baldes) > MAX_BALDES:
            for balde in sorted(self._baldes)[: len(self._baldes) - MAX_BALDES]:
                self._baldes.pop(balde, None)
                self._sujos.discard(balde)
                self._enviado_em.pop(balde, None)

    def lote_para_envio(self, agora: Optional[float] = None) -> List[Dict[str, Any]]:
        """Totais absolutos dos minutos alterados desde o último envio aceito."""
        agora = time.time() if agora is None else agora
        with self._lock:
            self._consolidar(agora)
            return [
                {
                    "minuteStart": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(minuto)),
                    "lineId": linha,
                    "lineName": self._nomes.get(linha, "Linha"),
                    "classLabel": classe,
                    "direction": direcao,
                    "count": self._baldes[(minuto, linha, classe, direcao)],
                }
                for (minuto, linha, classe, direcao) in sorted(self._sujos)
            ]

    def confirmar_envio(self, lote: List[Dict[str, Any]], agora: Optional[float] = None) -> None:
        """Marca como enviados os minutos do lote, se não mudaram desde então."""
        agora = time.time() if agora is None else agora
        with self._lock:
            for item in lote:
                minuto = calendar.timegm(time.strptime(item["minuteStart"], "%Y-%m-%dT%H:%M:%SZ"))
                balde: Chave = (minuto, item["lineId"], item["classLabel"], item["direction"])
                if self._baldes.get(balde) == item["count"]:
                    self._sujos.discard(balde)
                    self._enviado_em[balde] = agora
            for balde, quando in list(self._enviado_em.items()):
                if balde in self._sujos:
                    continue
                if agora - quando > GUARDAR_MINUTO_S and agora - balde[0] > GUARDAR_MINUTO_S:
                    self._baldes.pop(balde, None)
                    self._enviado_em.pop(balde, None)

    def estado(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "session": self.sessao,
                "entries": self.total_entradas,
                "exits": self.total_saidas,
                "cancelledJitter": self.anuladas,
                "ignoredRepeats": self.repetidas,
                "pendingCrossings": len(self._pendentes),
                "unsentMinutes": len(self._sujos),
            }


class EnvioDeContagem:
    """Thread leve que envia os totais à API a cada `INTERVALO_DE_ENVIO_S`."""

    def __init__(self, contador: ContadorDePassagem, enviar: Callable[[Dict[str, Any]], bool],
                 intervalo: float = INTERVALO_DE_ENVIO_S) -> None:
        self.contador = contador
        self._enviar = enviar
        self.intervalo = intervalo
        self._parar = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.ultimo_envio_ok_em: Optional[float] = None
        self.falhas_seguidas = 0

    def iniciar(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._parar.clear()
        self._thread = threading.Thread(target=self._rodar, name="contagem-envio", daemon=True)
        self._thread.start()

    def parar(self) -> None:
        self._parar.set()
        if self._thread:
            self._thread.join(timeout=5)
        # Último envio: o que foi contado até aqui não se perde num stop normal.
        # Avança o relógio além da espera para as pendentes entrarem no total.
        self.enviar_agora(time.time() + ESPERA_S)

    def _rodar(self) -> None:
        while not self._parar.wait(self.intervalo):
            self.enviar_agora()

    def enviar_agora(self, agora: Optional[float] = None) -> bool:
        lote = self.contador.lote_para_envio(agora)
        if not lote:
            return True
        try:
            ok = bool(self._enviar({"session": self.contador.sessao, "buckets": lote}))
        except Exception as exc:  # rede/API: tenta de novo no próximo ciclo
            logger.warning("envio de contagem falhou: %s", type(exc).__name__)
            ok = False
        if ok:
            self.contador.confirmar_envio(lote)
            self.ultimo_envio_ok_em = time.time()
            self.falhas_seguidas = 0
        else:
            self.falhas_seguidas += 1
        return ok
