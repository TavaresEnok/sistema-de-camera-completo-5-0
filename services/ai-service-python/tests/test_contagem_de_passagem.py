"""Testes da contagem de passagem (linha com uso "contagem").

Rodam sem cv2 e sem modelo: geometria + contador puro.
"""
import calendar
import time
import unittest

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


if __name__ == "__main__":
    unittest.main()
