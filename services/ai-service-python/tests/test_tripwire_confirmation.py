import unittest
from types import SimpleNamespace as S
from detectors.tripwire import DetectorDeTravessia

LINE = {'id':'l', 'kind':'line', 'points':[[.5,0],[.5,1]], 'sentido':'ambos'}
AREA = {'kind':'include', 'points':[[.5,0],[1,0],[1,1],[.5,1]]}

def det(x, confidence=.9, track=1, estimated=False):
    return S(bbox=[x-2,20,x+2,80], label='person', confidence=confidence,
             extra={'trackId':track,'estimated':estimated,'observedByModel':not estimated})

class CrossingConfirmation(unittest.TestCase):
    def detector(self, zones=None):
        return DetectorDeTravessia(zones or [LINE], confidence_threshold=.7, min_frames=3)

    def test_entry_and_exit_on_area_boundary(self):
        d=self.detector([LINE,AREA])
        result=[d.avaliar([det(x)],100,100,i) for i,x in enumerate([40,45,55,60,40])]
        self.assertEqual([len(v) for v in result],[0,0,1,0,1])
        self.assertNotEqual(result[2][0]['sentido'],result[4][0]['sentido'])

    def test_early_crossing_waits_for_evidence_once(self):
        d=self.detector()
        result=[len(d.avaliar([det(x)],100,100,i)) for i,x in enumerate([40,55,60,65])]
        self.assertEqual(result,[0,0,1,0])

    def test_low_confidence_never_confirms(self):
        d=self.detector()
        for i,x in enumerate([40,45,55,60,65]):
            self.assertEqual(d.avaliar([det(x,.35)],100,100,i),[])

    def test_expired_crossing_does_not_revive(self):
        d=self.detector()
        d.avaliar([det(40)],100,100,0)
        d.avaliar([det(55)],100,100,1)
        for t in [8,9,10]: self.assertEqual(d.avaliar([det(60)],100,100,t),[])

    def test_excluded_crossing_and_estimate_cannot_alert(self):
        exclude={'kind':'exclude','points':[[.45,0],[.55,0],[.55,1],[.45,1]]}
        d=self.detector([LINE,exclude])
        for i,x in enumerate([40,45,60,65]): self.assertEqual(d.avaliar([det(x)],100,100,i),[])
        d=self.detector()
        d.avaliar([det(40)],100,100,0)
        d.avaliar([det(45)],100,100,1)
        self.assertEqual(d.avaliar([det(60,estimated=True)],100,100,2),[])

if __name__=='__main__': unittest.main()
