import unittest
from workers.defaults import DEFAULTS, with_defaults
from workers.audio import validate
class Defaults(unittest.TestCase):
    def test_empty_and_partial(self):
        for kind in ('clean','master','subtitles','studio'):
            validate(kind,with_defaults(kind,{}))
        validate('clean',with_defaults('clean',{'noise':{'enabled':True}}))
        validate('master',with_defaults('master',{'compressor':{'enabled':True}}))
        validate('studio',with_defaults('studio',{'has_bed':True,'room_tone':{'enabled':True},'subtitles':{'enabled':True,'formats':[]}}))
    def test_explicit_invalid_and_legacy(self):
        with self.assertRaises(ValueError): validate('studio',with_defaults('studio',{'line_gap_ms':-1}))
        legacy=dict(noise=True,hum=False,reverb=False,voice=False,strength=50)
        self.assertEqual(with_defaults('clean',legacy),legacy)
