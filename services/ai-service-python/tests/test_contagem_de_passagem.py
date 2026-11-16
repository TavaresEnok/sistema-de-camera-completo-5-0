"""Testes da contagem de passagem (linha com uso "contagem").

Rodam sem cv2 e sem modelo: geometria + contador puro.
"""
import calendar
import time
import unittest
import tempfile
import os
import json

from contagem_de_passagem import (
    ESPERA_S,
    ContadorDePassagem,
    EnvioDeContagem,
    direcao_da_travessia,
    quadros_de_contagem,
)
from detectors.tripwire import DetectorDeTravessia, linhas_de

L, A = 640, 360


class Deteccao:
    def __init__(self, bbox, label="person", confidence=0.9, track_id="t1"):
        self.bbox = bbox
        self.label = label
        self.confidence = confidence
        self.extra = {"trackId": track_id}


def caixa_em(x_norm, y_norm, larg=0.1, alt=0.2):
    return [(x_norm - larg / 2) * L, y_norm * A - alt * A, (x_norm + larg / 2) * L, y_norm * A]


def linha_contagem(**extra):
    base = {"id": "porta", "name": "Porta", "kind": "line", "points": [[0.5, 0.2], [0.5, 0.8]],
            "uso": "contagem", "entrada": "ab"}
    base.update(extra)
    return [base]


def atravessar(detector, x_de, x_para, track="t1", label="person", t0=1000.0):
    """Leva o objeto de x_de a x_para em 3 quadros; devolve as travessias."""
    saidas = []
    for i, x in enumerate((x_de, (x_de + x_para) / 2 + 0.07 * (1 if x_para > x_de else -1), x_para)):
        saidas += detector.avaliar([Deteccao(caixa_em(x, 0.5), label=label, track_id=track)], L, A, agora=t0 + i * 0.2)
    return saidas


class LinhasDeContagem(unittest.TestCase):
    def test_linha_sem_uso_continua_sendo_alerta(self):
        linha = linhas_de([{"id": "l", "kind": "line", "points": [[0.5, 0.2], [0.5, 0.8]]}])[0]
        self.assertEqual(linha["uso"], "alerta")

    def test_campos_de_contagem(self):
        linha = linhas_de(linha_contagem(entrada="ba", classes=["car"]))[0]
        self.assertEqual((linha["uso"], linha["entrada"], linha["classes"]), ("contagem", "ba", {"car"}))

    def test_classe_padrao_e_pessoa(self):
        self.assertEqual(linhas_de(linha_contagem())[0]["classes"], {"person"})

    def test_contagem_nunca_e_proibida_e_traz_direcao(self):
        det = DetectorDeTravessia(linha_contagem(sentido="ambos"))
        travessias = atravessar(det, 0.3, 0.7)
        self.assertEqual(len(travessias), 1)
        t = travessias[0]
        self.assertFalse(t["proibido"])
        self.assertEqual(t["uso"], "contagem")
        self.assertEqual(t["direcao"], "in" if t["sentido"] == "ab" else "out")

    def test_sentido_contrario_e_saida(self):
        ida = atravessar(DetectorDeTravessia(linha_contagem()), 0.3, 0.7)[0]
        volta = atravessar(DetectorDeTravessia(linha_contagem()), 0.7, 0.3)[0]
        self.assertNotEqual(ida["direcao"], volta["direcao"])

    def test_crossing_at_included_boundary_accepts_both_directions(self):
        area = {'kind': 'include', 'points': [[0.5, 0], [1, 0], [1, 1], [0.5, 1]]}
        for start, end in ((0.3, 0.7), (0.7, 0.3)):
            detector = DetectorDeTravessia(linha_contagem() + [area])
            self.assertEqual(len(atravessar(detector, start, end)), 1)

    def test_rotulo_em_portugues_do_detector_conta(self):
        # O object_detector entrega "pessoa"; a linha guarda "person".
        det = DetectorDeTravessia(linha_contagem())
        self.assertEqual(len(atravessar(det, 0.3, 0.7, label="pessoa")), 1)
        det = DetectorDeTravessia(linha_contagem(classes=["carro"]))
        self.assertEqual(len(atravessar(det, 0.3, 0.7, label="carro")), 1)

    def test_contador_grava_classe_canonica(self):
        c = ContadorDePassagem(sessao="s1")
        c.registrar({"linhaId": "porta", "label": "pessoa", "trackId": "1", "direcao": "in"}, 1000.0)
        self.assertEqual(c.lote_para_envio(1010.0)[0]["classLabel"], "person")

    def test_classe_fora_da_linha_nao_conta(self):
        det = DetectorDeTravessia(linha_contagem())
        self.assertEqual(atravessar(det, 0.3, 0.7, label="car"), [])

    def test_linha_de_alerta_inalterada(self):
        det = DetectorDeTravessia([{"id": "l", "name": "Muro", "kind": "line",
                                    "points": [[0.5, 0.2], [0.5, 0.8]], "sentido": "ambos"}])
        t = atravessar(det, 0.3, 0.7)[0]
        self.assertTrue(t["proibido"])
        self.assertNotIn("uso", t)

    def test_direcao_da_travessia(self):
        self.assertEqual(direcao_da_travessia("ab", "ab"), "in")
        self.assertEqual(direcao_da_travessia("ba", "ab"), "out")


def travessia(direcao, track="t1", linha="porta"):
    return {"linhaId": linha, "linhaNome": "Porta", "label": "person", "trackId": track, "direcao": direcao}


class Contador(unittest.TestCase):
    def setUp(self):
        self.c = ContadorDePassagem(sessao="s1")
        self.t0 = float(calendar.timegm((2026, 11, 10, 15, 0, 10, 0, 0, 0)))

    def test_conta_depois_da_espera(self):
        self.c.registrar(travessia("in"), self.t0)
        self.assertEqual(self.c.lote_para_envio(self.t0 + 0.1), [])
        lote = self.c.lote_para_envio(self.t0 + ESPERA_S + 0.1)
        self.assertEqual(len(lote), 1)
        self.assertEqual(lote[0]["direction"], "in")
        self.assertEqual(lote[0]["count"], 1)
        self.assertEqual(lote[0]["minuteStart"], "2026-11-10T15:00:00Z")

    def test_tremor_na_linha_se_anula(self):
        self.c.registrar(travessia("in"), self.t0)
        self.c.registrar(travessia("out"), self.t0 + 0.5)
        self.assertEqual(self.c.lote_para_envio(self.t0 + 10), [])
        self.assertEqual(self.c.estado()["cancelledJitter"], 1)

    def test_mesmo_objeto_nao_entra_duas_vezes_seguidas(self):
        self.c.registrar(travessia("in"), self.t0)
        self.c.registrar(travessia("in"), self.t0 + 5)
        lote = self.c.lote_para_envio(self.t0 + 10)
        self.assertEqual(lote[0]["count"], 1)
        self.assertEqual(self.c.estado()["ignoredRepeats"], 1)

    def test_entra_e_sai_conta_os_dois(self):
        self.c.registrar(travessia("in"), self.t0)
        self.c.registrar(travessia("out"), self.t0 + 5)
        lote = {item["direction"]: item["count"] for item in self.c.lote_para_envio(self.t0 + 10)}
        self.assertEqual(lote, {"in": 1, "out": 1})

    def test_pessoas_diferentes_somam(self):
        for i in range(5):
            self.c.registrar(travessia("in", track=f"t{i}"), self.t0 + i * 0.1)
        self.assertEqual(self.c.lote_para_envio(self.t0 + 5)[0]["count"], 5)

    def test_envio_aceito_nao_reenvia_e_total_e_absoluto(self):
        self.c.registrar(travessia("in", track="a"), self.t0)
        lote = self.c.lote_para_envio(self.t0 + 2)
        self.c.confirmar_envio(lote, self.t0 + 2)
        self.assertEqual(self.c.lote_para_envio(self.t0 + 3), [])
        self.c.registrar(travessia("in", track="b"), self.t0 + 4)
        lote = self.c.lote_para_envio(self.t0 + 6)
        self.assertEqual(lote[0]["count"], 2)  # total do minuto, não o incremento

    def test_envio_falho_reenvia(self):
        self.c.registrar(travessia("in"), self.t0)
        envio = EnvioDeContagem(self.c, lambda payload: False)
        self.assertFalse(envio.enviar_agora(self.t0 + 2))
        self.assertEqual(len(self.c.lote_para_envio(self.t0 + 3)), 1)
        self.assertEqual(envio.falhas_seguidas, 1)

    def test_envio_leva_sessao(self):
        recebidos = []
        self.c.registrar(travessia("in"), self.t0)
        envio = EnvioDeContagem(self.c, lambda payload: recebidos.append(payload) or True)
        self.assertTrue(envio.enviar_agora(self.t0 + 2))
        self.assertEqual(recebidos[0]["session"], "s1")
        self.assertEqual(self.c.lote_para_envio(self.t0 + 3), [])


class QuadrosDeContagem(unittest.TestCase):
    def test_so_opcoes_da_tela(self):
        self.assertEqual([quadros_de_contagem(v) for v in (5, "8", 12, 7, None, "x")], [5, 8, 12, None, None, None])


class RecuperacaoDeContagem(unittest.TestCase):
    def test_backlog_above_api_limit_is_sent_in_chunks(self):
        c = ContadorDePassagem()
        for i in range(601):
            c.registrar(travessia('in', track=str(i)), 1_800_000_000 + i * 60)
        payloads = []
        sender = EnvioDeContagem(c, lambda p: payloads.append(p) or True)
        self.assertTrue(sender.enviar_agora(1_800_000_000 + 602 * 60))
        self.assertEqual([len(p['buckets']) for p in payloads], [500, 101])
        self.assertEqual(c.estado()['unsentMinutes'], 0)

    def test_partial_failure_retries_only_unacknowledged_chunk(self):
        c = ContadorDePassagem()
        for i in range(601):
            c.registrar(travessia('in', track=str(i)), 1_800_000_000 + i * 60)
        sizes = []
        def send(payload):
            sizes.append(len(payload['buckets']))
            return len(sizes) != 2
        sender = EnvioDeContagem(c, send)
        self.assertFalse(sender.enviar_agora(1_800_000_000 + 602 * 60))
        self.assertEqual(c.estado()['unsentMinutes'], 101)
        self.assertTrue(sender.enviar_agora(1_800_000_000 + 602 * 60))
        self.assertEqual(sizes, [500, 101, 101])

    def test_restart_preserves_session_and_absolute_totals(self):
        with tempfile.TemporaryDirectory() as directory:
            state = os.path.join(directory, 'camera.json')
            original = ContadorDePassagem(state_path=state)
            original.registrar(travessia('in', 'first'), 1_800_000_010)
            original.consolidar(1_800_000_012)
            restored = ContadorDePassagem(state_path=state)
            self.assertEqual(restored.sessao, original.sessao)
            self.assertEqual(restored.lote_para_envio(1_800_000_013)[0]['count'], 1)
            restored.registrar(travessia('in', 'second'), 1_800_000_014)
            self.assertEqual(restored.lote_para_envio(1_800_000_016)[0]['count'], 2)
            self.assertEqual(os.stat(state).st_mode & 0o777, 0o600)

    def test_restart_after_http_success_can_safely_resend(self):
        with tempfile.TemporaryDirectory() as directory:
            state = os.path.join(directory, 'camera.json')
            c = ContadorDePassagem(state_path=state)
            c.registrar(travessia('in'), 1_800_000_010)
            sent = c.lote_para_envio(1_800_000_012)
            c.confirmar_envio(sent, 1_800_000_012)
            restored = ContadorDePassagem(state_path=state)
            self.assertEqual(restored.lote_para_envio(1_800_000_013), sent)

    def test_disk_failure_is_visible_without_stopping_counting(self):
        with tempfile.NamedTemporaryFile() as occupied:
            c = ContadorDePassagem(state_path=occupied.name + '/camera.json')
            c.registrar(travessia('in'), 1_800_000_010)
            self.assertEqual(c.lote_para_envio(1_800_000_012)[0]['count'], 1)
            self.assertIsNotNone(c.estado()['storageError'])
            self.assertFalse(c.estado()['durableState'])

    def test_background_checkpoints_before_http_interval(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'camera.json')
            c = ContadorDePassagem(state_path=path)
            c.registrar(travessia('in'), time.time() - 3)
            requests = []
            sender = EnvioDeContagem(c, lambda p: requests.append(p) or True, intervalo=30)
            sender.iniciar()
            try:
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    if os.path.exists(path):
                        with open(path) as saved:
                            if json.load(saved)['entries'] == 1:
                                break
                    time.sleep(0.02)
                with open(path) as saved:
                    self.assertEqual(json.load(saved)['entries'], 1)
                self.assertEqual(requests, [])
            finally:
                sender.parar()


if __name__ == "__main__":
    unittest.main()
