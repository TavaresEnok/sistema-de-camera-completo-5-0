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
import json
import os
import tempfile
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
MAX_BALDES_POR_ENVIO = 500
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
    def __init__(self, sessao: Optional[str] = None, state_path: Optional[str] = None) -> None:
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
        self.descartados = 0
        self._state_path = state_path
        self._storage_error: Optional[str] = None
        if state_path:
            self._carregar()
            if self._storage_error is None and not os.path.exists(state_path):
                self._salvar()

    def _carregar(self) -> None:
        try:
            if not os.path.exists(self._state_path):
                return
            if os.path.getsize(self._state_path) > 2_000_000:
                raise ValueError('state too large')
            with open(self._state_path, encoding='utf-8') as source:
                data = json.load(source)
            if data.get('v') != 1 or not isinstance(data.get('session'), str) or not 8 <= len(data['session']) <= 64:
                raise ValueError('invalid state')
            restored = {}
            names = {}
            rows = data.get('buckets')
            if not isinstance(rows, list) or len(rows) > MAX_BALDES:
                raise ValueError('invalid buckets')
            for minute, line, label, direction, count, name in rows:
                if not isinstance(minute, int) or minute % 60 or not isinstance(count, int) or count < 0 or direction not in ('in', 'out'):
                    raise ValueError('invalid bucket')
                if not all(isinstance(v, str) and 0 < len(v) <= 128 for v in (line, label, name)):
                    raise ValueError('invalid labels')
                restored[(minute, line, label, direction)] = count
                names[line] = name
            self.sessao = data['session']
            self._baldes, self._nomes = restored, names
            # Resending acknowledged totals is safe, including a crash after HTTP success.
            self._sujos = set(restored)
            self.total_entradas = int(data.get('entries', 0))
            self.total_saidas = int(data.get('exits', 0))
        except (OSError, ValueError, TypeError, KeyError):
            self._storage_error = 'Não foi possível recuperar o estado da contagem.'
            logger.warning('falha ao recuperar estado persistido da contagem')

    def _salvar(self) -> None:
        if not self._state_path:
            return
        temporary = None
        try:
            directory = os.path.dirname(self._state_path)
            os.makedirs(directory, mode=0o700, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=directory, delete=False) as target:
                temporary = target.name
                json.dump({'v': 1, 'session': self.sessao, 'entries': self.total_entradas, 'exits': self.total_saidas,
                    'buckets': [[*k, count, self._nomes.get(k[1], 'Linha')] for k, count in self._baldes.items()]}, target)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, self._state_path)
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            self._storage_error = None
        except OSError:
            self._storage_error = 'Não foi possível salvar o estado da contagem.'
            logger.warning('falha ao persistir estado da contagem')
        finally:
            if temporary and os.path.exists(temporary):
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

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
        changed = False
        for chave, (direcao, quando, nome, classe) in list(self._pendentes.items()):
            if agora - quando < ESPERA_S:
                continue
            del self._pendentes[chave]
            changed = True
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
                self.descartados += 1
                changed = True
        if changed:
            self._salvar()

    def consolidar(self, agora: Optional[float] = None) -> None:
        with self._lock:
            self._consolidar(time.time() if agora is None else agora)

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
            removed = False
            for balde, quando in list(self._enviado_em.items()):
                if balde in self._sujos:
                    continue
                if agora - quando > GUARDAR_MINUTO_S and agora - balde[0] > GUARDAR_MINUTO_S:
                    self._baldes.pop(balde, None)
                    self._enviado_em.pop(balde, None)
                    removed = True
            if removed:
                self._salvar()

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
                "durableState": bool(self._state_path) and self._storage_error is None,
                "storageError": self._storage_error,
                "discardedBuckets": self.descartados,
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
        self._send_lock = threading.Lock()

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
        next_send = time.monotonic() + self.intervalo
        while not self._parar.wait(min(1.0, self.intervalo)):
            # Confirmed passages reach disk without waiting 30 seconds for HTTP.
            self.contador.consolidar()
            if time.monotonic() >= next_send:
                self.enviar_agora()
                next_send = time.monotonic() + self.intervalo

    def enviar_agora(self, agora: Optional[float] = None) -> bool:
        with self._send_lock:
            return self._enviar_lotes(agora)

    def _enviar_lotes(self, agora: Optional[float]) -> bool:
        lote = self.contador.lote_para_envio(agora)
        if not lote:
            return True
        ok = True
        for offset in range(0, len(lote), MAX_BALDES_POR_ENVIO):
            chunk = lote[offset:offset + MAX_BALDES_POR_ENVIO]
            try:
                accepted = bool(self._enviar({"session": self.contador.sessao, "buckets": chunk}))
            except Exception as exc:
                logger.warning("envio de contagem falhou: %s", type(exc).__name__)
                accepted = False
            if not accepted:
                ok = False
                break
            self.contador.confirmar_envio(chunk)
        if ok:
            self.ultimo_envio_ok_em = time.time()
            self.falhas_seguidas = 0
        else:
            self.falhas_seguidas += 1
        return ok
