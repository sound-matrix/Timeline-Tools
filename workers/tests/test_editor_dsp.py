import unittest
import numpy as np
from workers.editor_dsp import SPECS,InsertChain,validate_slots

def slot(kind,**params):
 p={k:v[0] for k,v in SPECS[kind].items()};p.update(params)
 return dict(id='fx_'+kind,type=kind,enabled=True,parameters=p)
class EditorDSP(unittest.TestCase):
 def test_streamed_chains_preserve_state_and_order_across_blocks(self):
  rng=np.random.default_rng(7);x=rng.normal(0,.15,(52000,2)).astype('float32')
  for kind in SPECS:
   slots=[slot(kind)]
   full=InsertChain(slots,8000).process(x)
   chain=InsertChain(slots,8000);stream=np.concatenate([chain.process(x[i:i+333]) for i in range(0,len(x),333)])
   np.testing.assert_allclose(full,stream,atol=2e-6,err_msg=kind);self.assertTrue(np.isfinite(full).all())
  first=InsertChain([slot('saturation',drive=8),slot('eq',g2=12)],8000).process(x)
  second=InsertChain([slot('eq',g2=12),slot('saturation',drive=8)],8000).process(x)
  self.assertGreater(float(np.max(np.abs(first-second))),.01)
 def test_bypass_eq_gain_tempo_delay_and_validation(self):
  x=np.zeros((16000,2),dtype='float32');x[0]=1
  s=slot('reverb');s['enabled']=False;np.testing.assert_array_equal(InsertChain([s],8000).process(x),x)
  echo=InsertChain([slot('delay',beats=1,mix=1,feedback=.5)],8000,120).process(x)
  self.assertAlmostEqual(float(echo[4000,0]),1);self.assertAlmostEqual(float(echo[8128,0]),.5)
  np.testing.assert_allclose(InsertChain([slot('eq')],8000).process(x),x,atol=1e-7)
  quiet=InsertChain([slot('gate',threshold=-6)],8000).process(x*.1);self.assertEqual(float(np.max(np.abs(quiet))),0)
  for bad in [dict(slot('delay'),parameters={'mix':.5}),slot('delay',feedback=1),dict(slot('eq'),enabled=1)]:
   with self.assertRaises(ValueError):validate_slots([bad])
