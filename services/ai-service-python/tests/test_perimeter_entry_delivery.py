import unittest
from types import SimpleNamespace
from detectors.confirmacao_de_objeto import ConfirmadorDeObjeto, PoliticaDeConfirmacao

AREA = {"kind":"include", "points":[[.5,0],[1,0],[1,1],[.5,1]]}
EXCLUDE = {"kind":"exclude", "points":[[.7,.3],[.9,.3],[.9,.9],[.7,.9]]}

def person(x, track=1, score=.9, estimated=False):
    return SimpleNamespace(label="pessoa", event_type="OBJECT_DETECTED", confidence=score,
        bbox=[x-5,10,x+5,70], extra={"trackId":track,"frameWidth":100,"frameHeight":100,
        "observedByModel":not estimated,"estimated":estimated})

class PerimeterEntryDelivery(unittest.TestCase):
    def test_outside_confirmation_does_not_consume_entry(self):
        c=ConfirmadorDeObjeto(PoliticaDeConfirmacao(), zonas=[AREA])
        for _ in range(5): self.assertEqual(c.avaliar([person(20)]), [])
        self.assertEqual(len(c.avaliar([person(60)])),1)
        for _ in range(20): self.assertEqual(c.avaliar([person(60)]), [])
        self.assertEqual(c.avaliar([person(20)]), [])
        self.assertEqual(len(c.avaliar([person(60)])),1)

    def test_exclusions_missing_geometry_and_estimates_never_trigger(self):
        c=ConfirmadorDeObjeto(PoliticaDeConfirmacao(), zonas=[AREA,EXCLUDE])
        for _ in range(5): self.assertEqual(c.avaliar([person(80)]), [])
        self.assertEqual(c.avaliar([person(60,estimated=True)]), [])
        self.assertEqual(len(c.avaliar([person(60)])),1)
        missing=person(60,track=2);missing.extra.pop('frameWidth')
        for _ in range(5): self.assertEqual(c.avaliar([missing]), [])

    def test_independent_people_keep_required_confirmation(self):
        c=ConfirmadorDeObjeto(PoliticaDeConfirmacao(), zonas=[AREA])
        for _ in range(2): self.assertEqual(c.avaliar([person(60),person(65,track=2)]), [])
        self.assertEqual(len(c.avaliar([person(60),person(65,track=2)])),2)

    def test_low_confidence_outside_does_not_bypass_entry_confidence(self):
        c=ConfirmadorDeObjeto(PoliticaDeConfirmacao(), zonas=[AREA])
        for _ in range(5): c.avaliar([person(20,score=.3)])
        self.assertEqual(c.avaliar([person(60)]), [])

    def test_distinct_confirmed_people_and_crossings_bypass_camera_grouping(self):
        try:
            from stream_processor import StreamProcessor
        except ImportError:
            self.skipTest('ML runtime required')
        from detectors.agrupamento_de_evento import AgrupadorDeEventos
        p=object.__new__(StreamProcessor);p._agrupador=AgrupadorDeEventos()
        self.assertTrue(p._decide_event(person(60,track=1),1)[0])
        self.assertTrue(p._decide_event(person(60,track=2),2)[0])
        crossing=person(60);crossing.event_type='LINE_CROSSED'
        self.assertTrue(p._decide_event(crossing,3)[0])
        motion=person(60);motion.event_type='MOTION_DETECTED'
        self.assertTrue(p._decide_event(motion,4)[0])
        self.assertFalse(p._decide_event(motion,5)[0])

if __name__=='__main__': unittest.main()
